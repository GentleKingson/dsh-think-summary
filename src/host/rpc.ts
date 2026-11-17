import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, readJsonBody, guard, HttpError } from './webserver.js'
import type { CtxLike } from './ctx.js'
import type { ThinkSummaryConfig } from './config.js'

export function installRpc(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig): void {
  whenWebServer(ctx, server => {
    server.register({ kind: 'exact', path: '/api/think-summary/state', handler(req, res) {
      if (!guard(req, res, 'GET')) return
      const sid = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId')
      if (!sid || sid.length > 256) throw new HttpError(400, 'sessionId required')
      writeJson(res, 200, { enabled: getOptions().enabled !== false, paused: store.paused, state: store.view(sid) ?? null })
    } })
    server.register({ kind: 'exact', path: '/api/think-summary/pause', async handler(req, res) {
      if (!guard(req, res, 'POST')) return
      const body = await readJsonBody<{ paused?: boolean }>(req)
      if (typeof body.paused !== 'boolean') throw new HttpError(400, 'paused must be boolean')
      store.paused = body.paused
      writeJson(res, 200, { ok: true, paused: store.paused })
    } })
  })
}
