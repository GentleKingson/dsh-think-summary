import test from 'node:test'
import assert from 'node:assert/strict'
import { RefineQueue, headTailTrim, trimToTokens } from '../lib/host/summarize/refine.js'
import { estimateTokens } from '../lib/host/detect.js'
import { task, until, delay } from './helpers.mjs'

test('configuration maps to model, budget, enable switch and bounded input', async () => {
  let options = { refineEnabled: false, refineModel: 'explicit', refineMaxInputTokens: 64, refineOutputTokens: 123 }
  const calls = [], applied = [], failed = []
  const queue = new RefineQueue(() => options, () => ({ async *stream(o) { calls.push(o); yield { type: 'text-delta', text: '中文摘要' } } }), (...a) => applied.push(a), (...a) => failed.push(a))
  assert.equal(queue.enqueue(task()), false)
  options.refineEnabled = true
  queue.enqueue(task())
  await until(() => queue.running === 0)
  assert.equal(calls[0].model, 'explicit')
  assert.equal(calls[0].maxTokens, 123)
  assert.equal(calls[0].purpose, 'think-summary')
  assert.equal(calls[0].tools, undefined)
  assert.equal(calls[0].sessionId, undefined)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.ok(estimateTokens(calls[0].messages[0].content[0].text) <= 64)
  assert.equal(applied[0][3], '中文摘要')
  options.refineModel = 'auto'; queue.enqueue(task(1))
  await until(() => queue.running === 0)
  assert.equal(calls[1].model, 'session-model')
  queue.dispose()
})

test('timeout aborts transport, releases worker and ignores late output', async () => {
  const calls = [], applied = [], failed = []
  let release
  const queue = new RefineQueue(() => ({ refineConcurrency: 1, refineTimeout: .02 }), () => ({ async *stream(o) {
    calls.push(o)
    if (calls.length === 1) await new Promise(r => { release = r })
    yield { type: 'text-delta', text: '完成' }
  } }), (...a) => applied.push(a), (...a) => failed.push(a))
  queue.enqueue(task()); queue.enqueue(task(1))
  await until(() => calls.length === 2 && queue.running === 0)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(failed[0][3], '精炼超时')
  assert.deepEqual(applied.map(a => a[2]), [1])
  release(); await delay(5)
  assert.equal(applied.length, 1)
  queue.dispose()
})

test('cancellation and unload clear waiting tasks, abort active work, callbacks cannot reject globally', async () => {
  let signal
  const queue = new RefineQueue(() => ({ refineConcurrency: 1 }), () => ({ async *stream(o) { signal = o.signal; await new Promise(() => {}) } }), () => { throw new Error('apply') }, () => { throw new Error('failure callback') })
  queue.enqueue(task()); queue.enqueue(task(1))
  await until(() => signal)
  queue.dispose()
  await until(() => queue.running === 0)
  assert.equal(signal.aborted, true)
  assert.equal(queue.pending, 0)
  assert.equal(queue.enqueue(task()), false)
})

test('primary abort cancels corresponding task; queue remains bounded', async () => {
  const controller = new AbortController()
  const queue = new RefineQueue(() => ({ refineConcurrency: 1 }), () => ({ async *stream() { await new Promise(() => {}) } }), () => {})
  queue.enqueue({ ...task(), signal: controller.signal })
  for (let i = 0; i < 100; i++) queue.enqueue(task(i + 1))
  assert.equal(queue.pending, 64)
  controller.abort()
  queue.cancelThink('session', 's1')
  await until(() => queue.running === 0)
  assert.equal(queue.pending, 0)
  queue.dispose()
})

test('provider errors and empty outputs retain heuristic without leaking error details', async () => {
  for (const mode of ['throw', 'chunk', 'empty', 'service']) {
    const failed = []
    const queue = new RefineQueue(() => ({}), () => {
      if (mode === 'service') throw new Error('secret-token')
      return { async *stream() {
        if (mode === 'throw') throw new Error('secret-token')
        if (mode === 'chunk') yield { type: 'finish', reason: { kind: 'error', failure: 'secret-token' } }
      } }
    }, () => assert.fail('must not replace heuristic'), (...args) => failed.push(args))
    queue.enqueue(task()); await until(() => queue.running === 0)
    assert.equal(failed.length, 1)
    assert.ok(!failed[0][3].includes('secret-token'))
    queue.dispose()
  }
})

test('token trimming obeys small budgets for mixed text', () => {
  for (const budget of [1, 8, 64, 128]) for (const trim of [headTailTrim, trimToTokens]) {
    assert.ok(estimateTokens(trim('中文 hello '.repeat(200), budget)) <= budget)
  }
})

test('queued fragments retain their original provider and configured model', async () => {
  const options = { refineConcurrency: 1, refineModel: '' }
  const calls = []
  const queue = new RefineQueue(() => options, () => ({ async *stream(request) {
    calls.push([request.provider, request.model])
    yield { type: 'text-delta', text: '摘要' }
  } }), () => {})
  assert.ok(queue.enqueue(task()))
  options.refineModel = 'secondary'
  assert.ok(queue.enqueue({ ...task(1), provider: 'internal' }))
  options.refineModel = 'another'
  assert.equal(queue.enqueue({ ...task(2), fallbackModel: '' }), false)
  assert.equal(queue.enqueue({ ...task(3), provider: '' }), false)
  await until(() => queue.running === 0)
  assert.deepEqual(calls, [['provider', 'session-model'], ['internal', 'secondary']])
  await queue.dispose()
})
