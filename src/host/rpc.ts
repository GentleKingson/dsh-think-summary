import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, readJsonBody, guard, HttpError } from './webserver.js'
import type { CtxLike } from './ctx.js'
import type { ThinkSummaryConfig } from './config.js'

import type { HostConnectionHandle, Principal } from '@deepseek-ai/dsh-client-connection'
import type { RouteReq } from './webserver.js'

function authorize(ctx: CtxLike, req: RouteReq, sessionId?: string) {
  const admission = ctx.get<HostConnectionHandle>('connection')?.admit(req)
  if (!admission) throw new HttpError(403, 'authentication unavailable')
  if ('rejection' in admission) throw new HttpError(admission.rejection, 'access denied')
  const principal = admission.peer.principal
  if (principal.kind === 'owner') return
  if (sessionId) {
    const access = ctx.get<{ decide(request: {
      principal: Principal; action: string; resources: { kind: 'session'; id: string }[]; args: { sessionId: string }
    }): { kind: string } }>('remoteAccess')
    const decision = access?.decide({
      principal, action: 'think-summary/state', resources: [{ kind: 'session', id: sessionId }], args: { sessionId },
    })
    if (decision?.kind === 'allow') return
  }
  throw new HttpError(403, 'access denied')
}

export function installRpc(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig): void {
  whenWebServer(ctx, server => {
    server.register({ kind: 'exact', path: '/api/think-summary/state', handler(req, res) {
      if (!guard(req, res, 'GET')) return
      const sid = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId')
      if (!sid || sid.length > 256) throw new HttpError(400, 'sessionId required')
      authorize(ctx, req, sid)
      writeJson(res, 200, { enabled: getOptions().enabled !== false, paused: store.paused, state: store.view(sid) ?? null })
    } })
    server.register({ kind: 'exact', path: '/api/think-summary/pause', async handler(req, res) {
      if (!guard(req, res, 'POST')) return
      authorize(ctx, req)
      const body = await readJsonBody<{ paused?: boolean }>(req)
      if (typeof body.paused !== 'boolean') throw new HttpError(400, 'paused must be boolean')
      store.paused = body.paused
      writeJson(res, 200, { ok: true, paused: store.paused })
    } })
  })
}
