import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
import { processThinking, decideRefine } from './summarize/pipeline.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/** rc.3 terminal messages already contain reasoning; don't duplicate the live stream in a buffer. */
export function installFallback(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig, refine?: RefineQueue | null) {
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session?.id
      const data = event?.data
      if (typeof sid !== 'string' || !data || !['assistant/chunk', 'assistant/message'].includes(event.type)) return
      const { turn, step } = data
      if (!Number.isInteger(turn) || !Number.isInteger(step)) return
      const state = store.get(sid)
      const realtime = state?.thinks.slice().reverse().find(t => t.id.startsWith('s') && t.turn === undefined)
      if (realtime) { realtime.turn = turn; realtime.step = step; store.touch(sid) }
      if (event.type !== 'assistant/message') return
      store.sweep()
      const opts = getOptions()
      if (opts.enabled === false || store.paused) return
      if (state?.thinks.some(t => t.turn === turn && t.step === step && t.segments.length)) return
      const blocks = data.message?.content
      if (!Array.isArray(blocks)) return
      let text = ''
      for (const block of blocks) {
        if (block?.type === 'reasoning' && typeof block.text === 'string') text += block.text.slice(0, 200_000 - text.length)
        if (text.length >= 200_000) break
      }
      if (estimateTokens(text) < (opts.thinkThresholdTokens ?? 2000)) return
      const outcomes = processThinking(text, {
        segmentMinTokens: opts.segmentMinTokens, segmentMaxTokens: opts.segmentMaxTokens,
        codeMode: opts.codeBlockMode === 'ignore' ? 'ignore' : 'keep',
        tableMode: opts.tableMode === 'ignore' ? 'ignore' : 'keep',
      }, { skipCode: opts.codeBlockMode !== 'keep-refine', skipTable: opts.tableMode !== 'keep-refine' })
      if (!outcomes.length) return
      const { state: target, think } = store.ensureThink(sid, `t${turn}_${step}`)
      think.turn = turn; think.step = step
      const source = data.message?.source
      for (const [i, outcome] of outcomes.entries()) {
        const index = think.segments.length
        const decision = decideRefine(opts, outcome.tokens, i === outcomes.length - 1)
        store.pushSegment(target, think.id, { index, summary: outcome.summary, tokens: outcome.tokens,
          refined: false, skipReason: outcome.skipReason, unrefinedReason: decision.unrefinedReason, ts: outcome.ts })
        if (refine && !outcome.skipReason && !decision.tooSmall) refine.enqueue({
          sessionId: sid, thinkId: think.id, segmentIndex: index, text: outcome.text,
          provider: source?.provider ?? '', fallbackModel: source?.model ?? '',
        })
      }
      think.tokens = estimateTokens(text)
      target.thinkingTokens = think.tokens
      store.touch(sid)
    } catch { /* fallback observers never interfere with the session */ }
  })
}
