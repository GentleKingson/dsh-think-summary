import { installDetect } from './host/stream.js'
import { ThinkStateStore } from './host/state.js'
import { installRpc } from './host/rpc.js'
import { installFallback } from './host/fallback.js'
import { installPersist } from './host/persist.js'
import { RefineQueue, type LlmLike } from './host/summarize/refine.js'
import { resolveConfig, type LiveConfig } from './host/config.js'
import type { CtxLike } from './host/ctx.js'
export { Config } from './host/config.js'
export const name = 'dsh-think-summary'

export async function apply(ctx: CtxLike, config: LiveConfig = {}) {
  const getConfig = () => resolveConfig(config)
  const store = new ThinkStateStore()
  const refine = new RefineQueue(
    () => ({ ...getConfig(), enabled: getConfig().enabled && !store.paused }),
    () => ctx.get('llm') as LlmLike | undefined,
    (sid, tid, index, summary, refineTokens) => store.updateSegment(sid, tid, index, {
      summary, refined: true, unrefinedReason: undefined, refineTokens,
    }),
    (sid, tid, index, reason) => store.updateSegment(sid, tid, index, { unrefinedReason: reason }),
  )
  const stop = () => refine.cancelAll('精炼已取消')
  store.onPause(stop)
  ctx.on('loader/volatile-update', () => {
    if (!getConfig().enabled || !getConfig().refineEnabled) stop()
  })
  await installPersist(ctx, store, getConfig)
  installDetect(ctx, store, getConfig, refine)
  installFallback(ctx, store, getConfig, refine)
  installRpc(ctx, store, getConfig)
  ctx.effect(() => () => refine.dispose())
}
