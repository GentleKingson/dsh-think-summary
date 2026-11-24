import { diagnose } from './diagnostics.js'
import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
import { processThinking, decideRefine } from './summarize/pipeline.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/** rc.3 terminal messages already contain reasoning; don't duplicate the live stream in a buffer. */
export function installFallback(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig, refine?: RefineQueue | null) {
  const sessions = new Map<string, { open: Set<string>; excluded: Set<string> }>()
  store.onPause(() => {
    for (const { open, excluded } of sessions.values()) {
      for (const key of open) excluded.add(key)
    }
  })
  ctx.on('session/disposed', session => {
    sessions.delete(session.id)
    store.untaggedPausedRequests.delete(session.id)
  })

  ctx.on('session/event', async (session, event) => {
    try {
      const sid = session?.id
      const data = event?.data
      if (typeof sid !== 'string' || !Number.isInteger(data?.turn)) return
      await store.ensureLoaded(sid)
      if (event.type === 'turn/start') {
        store.startTurn(sid, data.turn)
        return
      }
      if (!['step/start', 'step/end', 'assistant/chunk', 'assistant/message'].includes(event.type)) return
      const { turn, step } = data
      if (!Number.isInteger(turn) || !Number.isInteger(step)) return
      if (store.get(sid)) store.startTurn(sid, turn)
      const key = `${turn}_${step}`
      let steps = sessions.get(sid)
      if (!steps) {
        steps = { open: new Set(), excluded: new Set() }
        sessions.set(sid, steps)
      }
      if (event.type === 'step/end') {
        steps.open.delete(key)
        if (store.untaggedPausedRequests.delete(sid)) steps.excluded.add(key)
        return
      }
      if (event.type === 'step/start') {
        store.untaggedPausedRequests.delete(sid)
        steps.open.add(key)
        if (store.paused) steps.excluded.add(key)
        return
      }
      if (event.type === 'assistant/chunk') steps.open.add(key)
      if (store.untaggedPausedRequests.delete(sid) || store.paused) steps.excluded.add(key)
      const state = store.get(sid)
      if (state) {
        for (let i = state.thinks.length - 1; i >= 0; i--) {
          const think = state.thinks[i]!
          if (think.step !== undefined || !think.id.startsWith('s') || (think.turn !== undefined && think.turn !== turn)) continue
          think.turn = turn
          think.step = step
          store.touch(sid)
          break
        }
      }
      if (event.type !== 'assistant/message') return
      steps.open.delete(key)
      store.sweep()
      const opts = getOptions()
      if (opts.enabled === false || steps.excluded.has(key)) return
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
      store.startTurn(sid, turn)
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
    } catch { diagnose('fallback-observer') }
  })
}
