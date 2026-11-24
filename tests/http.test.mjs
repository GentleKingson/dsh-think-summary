import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { installRpc } from '../lib/host/rpc.js'
import { ThinkStateStore } from '../lib/host/state.js'
import { guard } from '../lib/host/webserver.js'
import { context } from './helpers.mjs'

test('HTTP methods, host, origin, bodies and unload are guarded', async () => {
  const routes = new Map(), store = new ThinkStateStore()
  const services = {
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { admit(req) {
      const cookie = req.headers.cookie
      if (cookie === 'owner' || cookie === 'reader') return { peer: { principal: { kind: cookie } } }
      return { rejection: 401 }
    } },
    remoteAccess: { decide({ principal, action, resources }) {
      const allowed = principal.kind === 'reader' && action === 'think-summary/state' &&
        resources.length === 1 && resources[0].kind === 'session' && resources[0].id === 's'
      return { kind: allowed ? 'allow' : 'deny' }
    } },
  }
  const ctx = context(services)
  let enabled = true
  installRpc(ctx, store, () => ({ enabled }))
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route) void route.handler(req, res)
    else { res.writeHead(404); res.end() }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const call = (path, method = 'GET', headers = {}, body = '') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { cookie: 'owner', ...headers } }, res => {
      let text = ''; res.on('data', c => { text += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    }); req.on('error', reject); req.end(body)
  })
  try {
    const path = '/api/think-summary/state?sessionId=s'
    const read = etag => call(path, 'GET', { 'if-none-match': etag })
    const first = await call(path)
    assert.equal(first.status, 200)
    const etag = first.headers.etag
    assert.ok(etag)
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { cookie: '', 'if-none-match': etag })).status, 401)
    const unchanged = await call('/api/think-summary/state?sessionId=s', 'GET', { 'if-none-match': etag })
    assert.equal(unchanged.status, 304); assert.equal(unchanged.text, '')
    assert.equal(unchanged.headers['cache-control'], 'no-store')
    assert.equal((await call('/api/think-summary/state?sessionId=other', 'GET', { cookie: 'reader', 'if-none-match': etag })).status, 403)
    store.startTurn('s', 1)
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { 'if-none-match': etag })).status, 200)
    assert.equal((await call('/api/think-summary/state')).status, 400)
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { cookie: '' })).status, 401)
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { cookie: 'reader' })).status, 200)
    assert.equal((await call('/api/think-summary/state?sessionId=other', 'GET', { cookie: 'reader' })).status, 403)
    assert.equal((await call('/api/think-summary/pause', 'POST', { cookie: 'reader', 'content-type': 'application/json' }, '{"paused":true}')).status, 403)
    const connection = services.connection
    delete services.connection
    assert.equal((await call('/api/think-summary/state?sessionId=s')).status, 403)
    services.connection = connection
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { host: 'evil.test' })).status, 403)
    assert.equal((await call('/api/think-summary/state?sessionId=s', 'GET', { origin: 'https://evil.test' })).status, 403)
    assert.equal((await call('/api/think-summary/pause')).status, 405)
    assert.equal((await call('/api/think-summary/pause', 'POST')).status, 415)
    const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }
    assert.equal((await call('/api/think-summary/pause', 'POST', headers, '{')).status, 400)
    assert.equal((await call('/api/think-summary/pause', 'POST', headers, '{}')).status, 400)
    assert.equal((await call('/api/think-summary/pause', 'POST', headers, JSON.stringify({ paused: true, big: '中'.repeat(6000) }))).status, 413)
    assert.equal(store.paused, false)
    assert.equal((await call('/api/think-summary/pause', 'POST', headers, '{"paused":true}')).status, 200)
    assert.equal(store.paused, true)

    const pausedState = await call(path)
    const { state, think } = store.beginThink('s')
    const started = await read(pausedState.headers.etag)
    assert.equal(JSON.parse(started.text).state.active, true)
    state.thinkingTokens = 100
    store.touch('s', false)
    const progress = await read(started.headers.etag)
    assert.equal(JSON.parse(progress.text).state.thinkingTokens, 100)
    store.pushSegment(state, think.id, { index: 0, summary: '原始摘要', tokens: 100, refined: false, ts: 1 })
    const segment = await read(progress.headers.etag)
    store.updateSegment('s', think.id, 0, { summary: '已精炼', refined: true })
    const refined = await read(segment.headers.etag)
    assert.equal(JSON.parse(refined.text).state.thinks[0].segments[0].summary, '已精炼')
    store.endThink('s', think.id)
    const ended = await read(refined.headers.etag)
    assert.equal(JSON.parse(ended.text).state.active, false)
    store.paused = false
    const resumed = await read(ended.headers.etag)
    assert.equal(JSON.parse(resumed.text).paused, false)
    enabled = false
    const disabled = await read(resumed.headers.etag)
    assert.equal(JSON.parse(disabled.text).enabled, false)
    await ctx.emit('dispose')
    assert.equal(routes.size, 0)
    installRpc(ctx, store, () => ({ enabled }))
    assert.equal((await read(disabled.headers.etag)).status, 200)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
})

test('missing or remote socket addresses fail closed', () => {
  for (const remoteAddress of [undefined, '192.168.1.10']) {
    let status
    assert.equal(guard({ method: 'GET', headers: { host: 'localhost' }, socket: { remoteAddress } }, { writeHead(s) { status = s }, end() {} }, 'GET'), false)
    assert.equal(status, 403)
  }
})
