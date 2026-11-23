import { diagnose } from './diagnostics.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CtxLike } from './ctx.js'
export type RouteReq = IncomingMessage
export type RouteRes = ServerResponse
interface WebRoute { kind: 'exact'; path: string; handler: (req: RouteReq, res: RouteRes) => unknown }

/** Re-register on service replacement; unregister on plugin unload. */
export function whenWebServer(ctx: CtxLike, register: (server: { register(route: WebRoute): unknown }) => void) {
  let current: unknown
  let disposers: (() => void)[] = []
  const clear = () => { for (const dispose of disposers.splice(0)) { try { dispose() } catch {} }; current = undefined }
  const attempt = () => {
    const server = ctx.get('webServer') as { register(route: WebRoute): unknown } | undefined
    if (server === current) return
    clear()
    if (!server) return
    try {
      register({ register(route) {
        const handler = route.handler
        const result = server.register({ ...route, handler: async (req, res) => {
          try { await handler(req, res) } catch (error) {
            if (!res.headersSent) writeJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: error instanceof HttpError ? error.message : 'internal error' })
          }
        } })
        if (typeof result === 'function') disposers.push(result as () => void)
        return result
      } })
      current = server
    } catch { clear(); diagnose('route-register') }
  }
  attempt()
  ctx.on('internal/service', (name: string) => { if (name === 'webServer') attempt() })
  ctx.effect(() => clear)
}
export function writeJson(res: RouteRes, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
function loopback(address: string | undefined) {
  return address === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(address ?? '')
}
/** Local-only surface: validate socket, Host and browser origin (DNS rebinding/CSRF). */
export function guard(req: RouteReq, res: RouteRes, method: 'GET' | 'POST'): boolean {
  if (req.method !== method) { writeJson(res, 405, { error: 'method not allowed' }); return false }
  let valid = loopback(req.socket?.remoteAddress)
  try {
    const host = new URL(`http://${req.headers.host}`)
    valid &&= host.hostname === 'localhost' || host.hostname === '[::1]' || loopback(host.hostname)
    const origin = req.headers.origin
    if (origin !== undefined) {
      const parsed = new URL(origin)
      valid &&= parsed.host === host.host && parsed.protocol === (('encrypted' in req.socket && req.socket.encrypted) ? 'https:' : 'http:')
    }
    valid &&= req.headers['sec-fetch-site'] !== 'cross-site'
  } catch { valid = false }
  if (!valid) { writeJson(res, 403, { error: 'forbidden' }); return false }
  if (method === 'POST' && req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    writeJson(res, 415, { error: 'application/json required' }); return false
  }
  return true
}
export async function readJsonBody<T>(req: RouteReq): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted)
    }
    const fail = (err: Error) => { cleanup(); req.resume(); reject(err) }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > 16_384) return fail(new HttpError(413, 'body too large'))
      chunks.push(Buffer.from(chunk))
    }
    const end = () => {
      cleanup()
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolve(value)
      } catch { reject(new HttpError(400, 'invalid JSON object')) }
    }
    const error = () => fail(new HttpError(400, 'body read failed'))
    const aborted = () => fail(new HttpError(400, 'request aborted'))
    const timer = setTimeout(() => fail(new HttpError(408, 'body timeout')), 5000)
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted)
  })
}
