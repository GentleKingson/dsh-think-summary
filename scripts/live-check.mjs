/** Explicit real-model test. Never part of npm test/CI; uses environment credentials only. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../lib/index.js'
import { sessionFile } from '../lib/host/persist.js'
import { testHostCookie } from './test-host-cookie.mjs'

const keyName = process.env.DSH_LIVE_KEY_ENV || 'api_key'
const key = process.env[keyName]
if (!key) throw new Error(`Credential environment variable ${keyName} is missing`)
const model = process.env.DSH_LIVE_MODEL || 'deepseek-flash'
const provider = 'deepseek-official'
const output = process.env.DSH_LIVE_REPORT
const home = await mkdtemp(join(tmpdir(), 'think-live-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const report = { hostVersion: '0.2.2-rc.3', model, startedAt: new Date().toISOString(), status: 'running', calls: [], checks: [] }
const ctx = new Context()
const llmFiber = ctx.plugin(LlmRuntime); await llmFiber
const serverFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await serverFiber
const config = resolveAdapterOptions({ baseURL: process.env.DSH_LIVE_BASE_URL || 'https://api.deepseek.com/anthropic', thinking: 'enabled', maxTokens: 4096, streamIdleTimeoutMs: 60000, retryPolicy: { mode: 'normal', maxRetries: 0 } })
ctx.llm.registerAdapter([provider], new DeepSeekAdapter({
  options: () => config,
  resolveAuth: async () => ({ headers: { 'x-api-key': key } }),
  resolveUserId: () => '00000000-0000-4000-8000-000000000001',
  prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
}))
// Record metadata only, never credentials, provider error bodies or raw reasoning.
ctx.on('llm/stream', (options, next) => {
  const row = { purpose: options.purpose || 'primary', model: options.model, hasTools: !!options.tools?.length, reasoningChars: 0, textChars: 0, elapsedMs: 0 }
  report.calls.push(row)
  const started = Date.now(), inner = next()
  return (async function*() {
    try {
      for await (const chunk of inner) {
        if (chunk.type === 'reasoning-delta') row.reasoningChars += chunk.text.length
        if (chunk.type === 'text-delta') row.textChars += chunk.text.length
        if (chunk.type === 'finish') { row.finish = chunk.reason.kind; row.errorCode = chunk.reason.failure?.code }
        if (chunk.type === 'usage') row.usage = chunk.usage
        yield chunk
      }
    } finally { row.elapsedMs = Date.now() - started; row.aborted = options.signal?.aborted === true }
  })()
})
const instance = ctx.plugin(plugin, {
  thinkThresholdTokens: 100, segmentMinTokens: 400, segmentMaxTokens: 800,
  refineConcurrency: 1, refineOutputTokens: 1024, refineTimeout: 60, persistEnabled: true,
})
await instance
const cookie = await testHostCookie(ctx)
const sid = `live-check-${randomUUID()}`
const state = async () => (await (await fetch(`${ctx.webServer.getOrigin()}/api/think-summary/state?sessionId=${sid}`, { headers: { cookie } })).json()).state
async function generate(messages, tools) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider, model, sessionId: sid, messages, ...(tools ? { tools } : {}), maxTokens: 4096, signal: AbortSignal.timeout(90000) })) assembler.push(chunk)
  assert.ok(['stop', 'tool-calls'].includes(assembler.finish.kind), `Provider ended with ${assembler.finish.kind}`)
  return assembler
}
try {
  console.log('Running real reasoning and segmentation...')
  const math = await generate([{ role: 'user', content: [{ type: 'text', text: '从1到12这12个整数中选出4个不同的数，要求和为26，且任意两个被选数都不相邻。请认真计算符合条件的组合总数，给出最终数量和简短的可复核验证方法。不要使用工具。' }] }])
  report.answer = math.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
  assert.ok(report.calls.some(c => c.purpose === 'primary' && c.reasoningChars > 100), 'No real reasoning observed')
  report.checks.push('Real reasoning stream and final answer received')
  console.log('Waiting for independent Chinese refinements...')
  const deadline = Date.now() + 90000
  let snapshot
  do {
    snapshot = await state()
    const segments = snapshot?.thinks.flatMap(t => t.segments) || []
    if (segments.length && segments.every(s => s.refined || s.skipReason || s.unrefinedReason)) break
    if (Date.now() > deadline) throw new Error('Refinement wait timed out')
    await new Promise(r => setTimeout(r, 250))
  } while (true)
  report.summaries = snapshot.thinks.flatMap(t => t.segments).map(s => ({ index: s.index, summary: s.summary, refined: s.refined, reason: s.unrefinedReason }))
  assert.ok(report.summaries.some(s => s.refined && /[\u4e00-\u9fff]/u.test(s.summary)), 'No successful Chinese refinement')
  assert.ok(report.calls.filter(c => c.purpose === 'think-summary').every(c => !c.hasTools))
  report.checks.push('Real model produced Chinese segment summaries; side calls have no tools')
  console.log('Running real model tool-call round trip...')
  const tools = [{ name: 'verification_echo', description: 'Return the provided marker for this regression test.', parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }]
  const user = { role: 'user', content: [{ type: 'text', text: '请调用 verification_echo，marker 参数必须为 DSH_RC3_TOOL_OK。收到工具结果后，最终答复只输出收到的 marker。' }] }
  const first = await generate([user], tools)
  const call = first.blocks().find(b => b.type === 'tool-call')
  assert.equal(call?.name, 'verification_echo')
  const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
  assert.equal(args.marker, 'DSH_RC3_TOOL_OK')
  // Execute only this harmless local test tool; never evaluate model-generated commands.
  const toolResult = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: args.marker }], isError: false })
  const second = await generate([user, first.message({ provider, model }), toolResult], tools)
  report.toolAnswer = second.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
  assert.ok(report.toolAnswer.includes('DSH_RC3_TOOL_OK'))
  report.checks.push('Real tool-call -> local verification_echo -> real final answer succeeded')
  await instance.dispose()
  const saved = JSON.parse(await readFile(sessionFile(join(home, 'dsh-think-summary', 'sessions'), sid), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.session.sessionId, sid)
  assert.ok(saved.session.thinks.some(t => t.segments.some(seg => seg.refined)))
  report.checks.push('Final refined state persisted on unload')
  const restored = ctx.plugin(plugin, { refineEnabled: false, persistEnabled: true }); await restored
  assert.ok((await state()).thinks.some(t => t.segments.some(s => s.refined)))
  await restored.dispose()
  report.checks.push('Reload restored real model summaries')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.message).split(key).join('<redacted>').slice(0, 400)
  process.exitCode = 1
} finally {
  await instance.dispose()
  await serverFiber.dispose(); await llmFiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  report.finishedAt = new Date().toISOString()
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
