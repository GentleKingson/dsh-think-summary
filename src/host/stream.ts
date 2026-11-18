import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ThinkingDetector } from './detect.js'
import type { ThinkStateStore } from './state.js'
import { Segmenter } from './segment.js'
import { summarizeSegment } from './summarize/heuristic.js'
import { decideRefine } from './summarize/pipeline.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/** Observe rc.3 streams without changing request data, chunk identity or upstream failures. */
export function installDetect(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig, refine?: RefineQueue | null) {
  ctx.on('llm/stream', (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    let options: ThinkSummaryConfig
    try { options = getOptions() } catch { return next() }
    if (options.enabled === false || request.purpose || !request.sessionId) return next()
    const { sessionId, provider, model } = request
    if (store.paused) {
      store.untaggedPausedRequests.add(sessionId)
      return next()
    }
    // Call upstream exactly once, outside summary error handling.
    const inner = next()
    try {
      const { state, think } = store.beginThink(sessionId)
      const detector = new ThinkingDetector({ thinkThresholdTokens: options.thinkThresholdTokens })
      const segmenter = new Segmenter({
        segmentMinTokens: options.segmentMinTokens,
        segmentMaxTokens: options.segmentMaxTokens,
        canCut: () => detector.inSplice,
        codeMode: options.codeBlockMode === 'ignore' ? 'ignore' : 'keep',
        tableMode: options.tableMode === 'ignore' ? 'ignore' : 'keep',
      }, (text, tokens, meta, isTail, rawTokens) => {
        const index = think.segments.length
        const choice = summarizeSegment(text, meta, {
          skipCode: options.codeBlockMode === 'keep-skip',
          skipTable: options.tableMode === 'keep-skip',
        })
        const decision = decideRefine(options, tokens, isTail)
        store.pushSegment(state, think.id, {
          index, summary: choice.summary, tokens, rawTokens: rawTokens ?? tokens,
          refined: false, skipReason: choice.skipReason,
          unrefinedReason: decision.unrefinedReason, ts: Date.now(),
        })
        if (refine && !choice.skipReason && !decision.tooSmall) refine.enqueue({
          sessionId, thinkId: think.id, segmentIndex: index, text,
          provider, fallbackModel: model, signal: request.signal,
        }, options.refineModel)
      })
      let blockType: string | null = null
      let wasPaused = false
      let failed = false
      const observe = (chunk: StreamChunk) => {
        const paused = store.paused || getOptions().enabled === false
        if (paused && !wasPaused) {
          if (store.paused && think.turn === undefined) store.untaggedPausedRequests.add(sessionId)
          segmenter.resetForPause()
          detector.reset()
          think.tokens = 0
          state.thinkingTokens = 0
          state.inSplice = false
          state.updatedAt = Date.now()
        }
        wasPaused = paused
        if (chunk.type === 'block-start') {
          if (blockType === 'reasoning' && chunk.blockType !== 'reasoning') segmenter.signalBoundary()
          blockType = chunk.blockType
        } else if (chunk.type === 'reasoning-delta' && !paused) {
          segmenter.feed(chunk.text, raw => detector.feedRaw(raw, { onSpliceStart: () => { state.inSplice = true } }))
          think.tokens = detector.thinkingTokens
          state.thinkingTokens = think.tokens
          state.updatedAt = Date.now()
        } else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failed = true
            refine?.cancelThink(sessionId, think.id)
          }
          if (!failed && !paused) segmenter.flush()
          store.endThink(sessionId, think.id)
        }
      }
      return (async function* () {
        let completed = false
        try {
          for await (const chunk of inner) {
            if (!failed) {
              try { observe(chunk) } catch { failed = true }
            }
            yield chunk
          }
          completed = true
        } finally {
          try {
            if (!failed && !store.paused && getOptions().enabled !== false) segmenter.flush()
          } catch { /* Summary failure must not mask upstream errors or completion. */ }
          try { store.endThink(sessionId, think.id) } catch {}
          try { if (!completed || request.signal?.aborted) refine?.cancelThink(sessionId, think.id) } catch {}
        }
      })()
    } catch { return inner }
  })
}
