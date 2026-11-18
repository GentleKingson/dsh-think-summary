/** Opt-in integration against an official dsh-v0.2.2-rc.3 checkout; no copied forwarding implementation. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../lib/index.js'

const root = process.env.DSH_OFFICIAL_SOURCE
if (!root) throw new Error('Set DSH_OFFICIAL_SOURCE to the official rc.3 checkout')
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(commit, '38a6a5c965aa99ab525161efb7cc5cf1fe62fced')
const { forwardWebRequest } = await import(pathToFileURL(join(root, 'apps/desktop/src/web-document.ts')).href)
const ctx = new Context()
const host = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await host
const origin = ctx.webServer.getOrigin()
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'think-desktop-'))
const instance = ctx.plugin(plugin, { persistEnabled: false, refineEnabled: false })
await instance
const checks = []
const forward = (path, init = {}) => forwardWebRequest(new Request(`dsh-app://app${path}`, init), origin, 'test-owned-host-cookie')
try {
  const state = await forward('/api/think-summary/state?sessionId=desktop-test', { headers: { origin: 'dsh-app://app' } })
  assert.equal(state.status, 200)
  assert.equal((await state.json()).enabled, true)
  checks.push('Desktop custom-scheme GET -> actual rc.3 WebServer -> plugin: 200')
  const pause = await forward('/api/think-summary/pause', { method: 'POST', headers: { origin: 'dsh-app://app', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"paused":true}' })
  assert.equal(pause.status, 200)
  assert.equal((await pause.json()).paused, true)
  checks.push('Desktop JSON POST pause: 200 and state updated')
  const blocked = await forward('/api/think-summary/pause', { method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: '{"paused":false}' })
  assert.equal(blocked.status, 403)
  checks.push('Official Desktop forwarder rejects foreign origin: 403')
  const unsafeDirect = await fetch(`${origin}/api/think-summary/state?sessionId=desktop-test`, { headers: { origin: 'dsh-app://app' } })
  assert.equal(unsafeDirect.status, 403)
  checks.push('Direct custom-origin HTTP remains rejected: 403; no guard weakening')
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const release = ctx.webServer.register({ kind: 'exact', path: '/plugins/dsh-think-summary/client.js', handler(req, res) { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(bundle) } })
  const client = await forward('/plugins/dsh-think-summary/client.js')
  assert.equal(client.status, 200)
  assert.equal(client.headers.get('cache-control'), 'no-store')
  assert.equal(await client.text(), bundle)
  release()
  checks.push('Client bundle forwarded unchanged and marked no-store')
  await instance.dispose()
  const gone = await forward('/api/think-summary/state?sessionId=desktop-test')
  assert.equal(gone.status, 404)
  checks.push('Plugin unload removes Desktop-visible routes: 404')
  console.log(JSON.stringify({ officialCommit: commit, status: 'passed', checks, scope: 'Real official forwarding code + rc.3 Host; no Electron GUI launched' }, null, 2))
} finally {
  await instance.dispose()
  await host.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
}
