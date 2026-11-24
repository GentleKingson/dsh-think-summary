/** Real transport cancellation/timeout probe; explicit invocation only. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import llmPackage from '@deepseek-ai/dsh-llm/package.json' with { type: 'json' }
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { RefineQueue } from '../lib/host/summarize/refine.js'
const key = process.env[process.env.DSH_LIVE_KEY_ENV || 'api_key']
if (!key) throw new Error('Live model credential is missing')
const model = process.env.DSH_LIVE_MODEL || 'deepseek-flash'
const ctx = new Context(), fiber = ctx.plugin(LlmRuntime)
await fiber
const connection = resolveAdapterOptions({ baseURL: process.env.DSH_LIVE_BASE_URL || 'https://api.deepseek.com/anthropic', thinking: 'enabled', retryPolicy: { mode: 'normal', maxRetries: 0 } })
ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({ options: () => connection,
  resolveAuth: async () => ({ headers: { 'x-api-key': key } }), resolveUserId: () => '00000000-0000-4000-8000-000000000001',
  prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
}))
const report = { hostVersion: llmPackage.version, model, status: 'running', startedAt: new Date().toISOString(), probes: [] }
let mode = 'cancel', current, queue
ctx.on('llm/stream', (options, next) => {
  const probe = { mode, firstProviderDelta: false, signalAborted: false, transportEnded: false }
  current = probe; report.probes.push(probe)
  const inner = next(), started = Date.now()
  return (async function*() {
    try {
      for await (const chunk of inner) {
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          probe.firstProviderDelta = true
          if (probe.mode === 'cancel') queue.cancelAll('精炼已取消')
        }
        yield chunk
      }
    } finally { probe.signalAborted = options.signal.aborted; probe.transportEnded = true; probe.elapsedMs = Date.now() - started }
  })()
})
const failures = [], applied = []
queue = new RefineQueue(() => ({ refineConcurrency: 1, refineTimeout: mode === 'timeout' ? 1 : 30 }), () => ctx.llm,
  (...args) => applied.push(args), (...args) => failures.push(args[3]))
const task = index => ({ sessionId: 'live-cancel', thinkId: 'test', segmentIndex: index, provider: 'deepseek-official', fallbackModel: model,
  text: '该系统通过任务队列控制并发，使用取消信号中断网络请求，超时后释放并发位，保留原始摘要，禁止迟到结果覆盖，重启后恢复历史。'.repeat(15) })
const wait = async condition => {
  const deadline = Date.now() + 40000
  while (!condition()) { if (Date.now() > deadline) throw new Error('Probe timed out'); await new Promise(r => setTimeout(r, 50)) }
}
try {
  queue.enqueue(task(0))
  await wait(() => queue.running === 0 && current?.transportEnded)
  assert.equal(current.firstProviderDelta, true)
  assert.equal(current.signalAborted, true)
  assert.equal(failures[0], '精炼已取消')
  assert.equal(applied.length, 0)
  mode = 'timeout'
  queue.enqueue(task(1))
  await wait(() => queue.running === 0 && current?.mode === 'timeout' && current.transportEnded)
  assert.equal(current.signalAborted, true)
  assert.equal(failures[1], '精炼超时')
  assert.equal(applied.length, 0)
  assert.equal(queue.pending, 0)
  report.status = 'passed'
  report.failures = failures
  report.appliedAfterCancellation = applied.length
} catch (error) {
  report.status = 'failed'; report.failure = String(error.message).split(key).join('<redacted>').slice(0, 300); process.exitCode = 1
} finally {
  await queue.dispose(); await fiber.dispose()
  report.finishedAt = new Date().toISOString()
  if (process.env.DSH_LIVE_REPORT) await writeFile(process.env.DSH_LIVE_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
