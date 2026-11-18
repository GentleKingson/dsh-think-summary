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
  const ctx = context({ webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  installRpc(ctx, store, () => ({}))
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route) void route.handler(req, res)
    else { res.writeHead(404); res.end() }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const call = (path, method = 'GET', headers = {}, body = '') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.on('data', c => { text += c }); res.on('end', () => resolve({ status: res.statusCode, text }))
    }); req.on('error', reject); req.end(body)
  })
  try {
    assert.equal((await call('/api/think-summary/state?sessionId=s')).status, 200)
    assert.equal((await call('/api/think-summary/state')).status, 400)
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
    await ctx.emit('dispose')
    assert.equal(routes.size, 0)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
})

test('missing or remote socket addresses fail closed', () => {
  for (const remoteAddress of [undefined, '192.168.1.10']) {
    let status
    assert.equal(guard({ method: 'GET', headers: { host: 'localhost' }, socket: { remoteAddress } }, { writeHead(s) { status = s }, end() {} }, 'GET'), false)
    assert.equal(status, 403)
  }
})
