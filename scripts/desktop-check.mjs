/** Opt-in integration against the official source tag matching the installed WebServer. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import webServerPackage from '@deepseek-ai/dsh-host-webserver/package.json' with { type: 'json' }
import * as plugin from '../lib/index.js'
import { testHostCookie } from './test-host-cookie.mjs'

const root = process.env.DSH_OFFICIAL_SOURCE
const hostVersion = webServerPackage.version
const tag = `dsh-v${hostVersion}`
if (!root) throw new Error(`Set DSH_OFFICIAL_SOURCE to the official ${tag} checkout`)
const revision = ref => execFileSync('git', ['-C', root, 'rev-parse', '--verify', ref], { encoding: 'utf8' }).trim()
const commit = revision('HEAD')
assert.equal(commit, revision(`refs/tags/${tag}^{commit}`), `Expected the official ${tag} checkout`)
const { forwardWebRequest } = await import(pathToFileURL(join(root, 'apps/desktop/src/web-document.ts')).href)
const ctx = new Context()
const host = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await host
const origin = ctx.webServer.getOrigin()
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'think-desktop-'))
const instance = ctx.plugin(plugin, { persistEnabled: false, refineEnabled: false })
await instance
const cookie = await testHostCookie(ctx)
const checks = []
const forward = (path, init = {}) => forwardWebRequest(new Request(`dsh-app://app${path}`, init), origin, cookie)
try {
  const state = await forward('/api/think-summary/state?sessionId=desktop-test', { headers: { origin: 'dsh-app://app' } })
  assert.equal(state.status, 200)
  assert.equal((await state.json()).enabled, true)
  checks.push('Desktop custom-scheme GET -> WebServer -> plugin: 200')
  const etag = state.headers.get('etag')
  assert.ok(etag)
  const unchanged = await forward('/api/think-summary/state?sessionId=desktop-test', { headers: { 'if-none-match': etag } })
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.headers.get('etag'), etag)
  assert.equal(await unchanged.text(), '')
  checks.push('Desktop conditional state GET: 304 with empty body')
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
  console.log(JSON.stringify({
    hostVersion, officialCommit: commit, status: 'passed', checks,
    scope: 'Official Desktop forwarder and WebServer integration',
  }, null, 2))
} finally {
  await instance.dispose()
  await host.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
}
