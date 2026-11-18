import test from 'node:test'
import assert from 'node:assert/strict'
import { installDetect } from '../lib/host/stream.js'
import { installFallback } from '../lib/host/fallback.js'
import { ThinkStateStore } from '../lib/host/state.js'
import { resolveConfig } from '../lib/host/config.js'
import { context } from './helpers.mjs'
const options = () => resolveConfig({ thinkThresholdTokens: 100, segmentMinTokens: 100, segmentMaxTokens: 200, refineEnabled: false })
const chunks = [ { type: 'reasoning-delta', text: '分析中文问题并给出结论。'.repeat(80) }, { type: 'tool-call-start', id: 'tool-1', name: 'bash' }, { type: 'tool-call-delta', id: 'tool-1', arguments: '{}' }, { type: 'text-delta', text: 'answer' }, { type: 'finish' } ]
async function collect(stream) { const out = []; for await (const chunk of stream) out.push(chunk); return out }
function setup(store = new ThinkStateStore(), refine) { const ctx = context(); installDetect(ctx, store, options, refine); return { store, wrap: ctx.events.get('llm/stream')[0] } }

test('all primary chunks preserve identity and upstream arguments; auxiliary requests bypass observation', async () => {
  const { store, wrap } = setup()
  const request = { sessionId: 's', provider: 'p', model: 'm', tools: ['original'] }
  const original = structuredClone(request)
  const output = await collect(wrap(request, () => (async function*() { yield* chunks })()))
  output.forEach((chunk, index) => assert.equal(chunk, chunks[index]))
  assert.deepEqual(request, original)
  assert.ok(store.get('s').thinks[0].segments.length)
  for (const purpose of ['think-summary', 'compaction', 'session-title']) {
    const inner = (async function*() { yield* chunks })()
    assert.equal(wrap({ ...request, purpose }, () => inner), inner)
  }
})

test('summary observer failures do not interrupt tool or text chunks', async () => {
  const store = new ThinkStateStore()
  store.pushSegment = () => { throw new Error('observer failed') }
  const { wrap } = setup(store)
  assert.deepEqual(await collect(wrap({ sessionId: 's' }, () => (async function*() { yield* chunks })())), chunks)
  assert.equal(store.get('s').active, false)
})

test('upstream error identity and iterator cleanup survive plugin failure', async () => {
  const err = new Error('upstream')
  let closed = false, cancelled = 0
  const { wrap } = setup(undefined, { enqueue() {}, cancelThink() { cancelled++ } })
  const inner = (async function*() { try { yield chunks[0]; throw err } finally { closed = true } })()
  await assert.rejects(collect(wrap({ sessionId: 's' }, () => inner)), error => error === err)
  assert.equal(closed, true); assert.equal(cancelled, 1)
})

test('consumer early return closes upstream and cancels its refine work', async () => {
  let closed = false, cancelled = 0
  const { wrap } = setup(undefined, { enqueue() {}, cancelThink() { cancelled++ } })
  const wrapped = wrap({ sessionId: 's' }, () => (async function*() { try { yield* chunks } finally { closed = true } })())
  for await (const chunk of wrapped) break
  assert.equal(closed, true); assert.equal(cancelled, 1)
})

test('same reasoning in different turns retains both history groups', async () => {
  const { wrap, store } = setup()
  for (let i = 0; i < 2; i++) await collect(wrap({ sessionId: 's' }, () => (async function*() { yield* chunks })()))
  assert.ok(store.get('s').thinks.every(t => t.segments.length > 0))
})

test('fallback respects ignore modes and stable indices; duplicate message is idempotent', async () => {
  const ctx = context(), store = new ThinkStateStore(), tasks = []
  installFallback(ctx, store, options, { enqueue(task) { tasks.push(task) } })
  const text = '```js\n' + 'code\n'.repeat(150) + '```\n' + '分析问题。'.repeat(100)
  const data = { turn: 1, step: 2, chunk: { type: 'reasoning-delta', text } }
  await ctx.emit('session/event', { id: 's' }, { type: 'assistant/chunk', data })
  const message = { type: 'assistant/message', data: { turn: 1, step: 2, message: { source: { provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text }] } } }
  await ctx.emit('session/event', { id: 's' }, message)
  const segments = store.get('s').thinks[0].segments
  assert.ok(segments.length > 0)
  assert.deepEqual(segments.map(s => s.index), segments.map((s, i) => i))
  assert.ok(segments.every(s => s.skipReason !== 'code'))
  assert.equal(tasks[0].provider, 'p')
  await ctx.emit('session/event', { id: 's' }, message)
  assert.equal(store.get('s').thinks[0].segments.length, segments.length)
})

test('rc.3 error finish preserves original chunk and cancels side work', async () => {
  let cancelled = 0
  const { wrap } = setup(undefined, { enqueue() {}, cancelThink() { cancelled++ } })
  const terminal = { type: 'finish', reason: { kind: 'error', failure: { message: 'host error' } } }
  const out = await collect(wrap({ sessionId: 's' }, () => (async function*() { yield chunks[0]; yield terminal })()))
  assert.equal(out.at(-1), terminal)
  assert.equal(cancelled, 1)
})


test('short retained code does not bypass the long-thinking threshold', async () => {
  const ctx = context(), store = new ThinkStateStore()
  installDetect(ctx, store, () => resolveConfig({ codeBlockMode: 'keep-skip' }))
  const wrap = ctx.events.get('llm/stream')[0]
  const short = { type: 'reasoning-delta', text: '```js\nconst x = 1\n```\n' }
  await collect(wrap({ sessionId: 's' }, () => (async function*() { yield short })()))
  assert.equal(store.get('s').thinks[0].segments.length, 0)
})

test('fallback excludes paused steps across resume, terminal replay and interleaved sessions', async () => {
  const ctx = context(), store = new ThinkStateStore(), tasks = []
  const refine = { enqueue: task => tasks.push(task) }
  installDetect(ctx, store, options, refine)
  installFallback(ctx, store, options, refine)
  const send = (sid, type, step, text) => ctx.emit('session/event', { id: sid }, {
    type, data: { turn: 1, step, message: { content: [{ type: 'reasoning', text }] } },
  })
  const secret = '暂停内容'.repeat(100), allowed = '正常内容'.repeat(100)
  await send('active', 'step/start', 1)
  store.paused = true
  await send('paused', 'step/start', 1)
  await send('chunk-only', 'assistant/chunk', 1)
  const wrap = ctx.events.get('llm/stream')[0]
  await collect(wrap({ sessionId: 'stream-only' }, () => (async function* () {
    yield { type: 'reasoning-delta', text: secret }
  })()))
  store.paused = false
  for (const sid of ['active', 'paused', 'chunk-only', 'stream-only']) {
    await send(sid, 'assistant/message', 1, secret)
    await send(sid, 'step/end', 1)
    await send(sid, 'assistant/message', 1, secret)
    assert.equal(store.get(sid), undefined)
  }
  assert.equal(tasks.length, 0)
  await send('other', 'assistant/message', 1, allowed)
  await send('paused', 'step/start', 2)
  await send('paused', 'assistant/message', 2, allowed)
  assert.deepEqual(tasks.map(t => t.sessionId), ['other', 'paused'])
})

for (const mode of ['keep-skip', 'keep-refine']) {
  test(mode + ' emits earlier closed fences in order when a later delta crosses the threshold', async () => {
    const ctx = context(), store = new ThinkStateStore(), tasks = []
    installDetect(ctx, store, () => ({ ...options(), codeBlockMode: mode, thinkThresholdTokens: 500 }),
      { enqueue: task => tasks.push(task) })
    const wrap = ctx.events.get('llm/stream')[0]
    const fences = ['first', 'second'].map(name => '```js\n' + name.repeat(100) + '\n```')
    const prose = '正常正文'.repeat(150)
    await collect(wrap({ sessionId: 's' }, () => (async function* () {
      for (const text of fences) yield { type: 'reasoning-delta', text: text + '\n' }
      assert.equal(store.get('s').thinks[0].segments.length, 0)
      yield { type: 'reasoning-delta', text: prose }
    })()))
    const segments = store.get('s').thinks[0].segments
    assert.deepEqual(segments.map(s => s.index), [0, 1, 2])
    assert.match(segments[0].summary, /first/)
    assert.match(segments[1].summary, /second/)
    assert.deepEqual(tasks.map(t => t.text), mode === 'keep-refine' ? [...fences, prose] : [prose])
  })
}

test('ignored table cell spanning several slices never reaches refinement', async () => {
  const ctx = context(), store = new ThinkStateStore(), tasks = []
  installDetect(ctx, store, options, { enqueue: task => tasks.push(task) })
  const wrap = ctx.events.get('llm/stream')[0]
  const prose = '表格之后的正文'.repeat(80)
  await collect(wrap({ sessionId: 's' }, () => (async function* () {
    yield { type: 'reasoning-delta', text: '| field | value |\n|--|--|\n| hidden | ' }
    for (let i = 0; i < 20; i++) yield { type: 'reasoning-delta', text: 'secret!'.repeat(1_500) }
    yield { type: 'reasoning-delta', text: '\n' + prose }
  })()))
  assert.deepEqual(tasks.map(t => t.text), [prose])
  const [segment] = store.get('s').thinks[0].segments
  assert.ok(segment.rawTokens > 50_000)
})
