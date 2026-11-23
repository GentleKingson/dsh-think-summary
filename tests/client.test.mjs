import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

async function client(fetch) {
  const timers = new Map(), events = new Map()
  let id = 0
  const document = { hidden: false, addEventListener(name, cb) { events.set(name, cb) }, removeEventListener(name) { events.delete(name) } }
  const sandbox = vm.createContext({ fetch, document, AbortController, console,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key }, clearTimeout(key) { timers.delete(key) },
  })
  const code = await readFile(new URL('../src/client/utils.js', import.meta.url), 'utf8')
  vm.runInContext("const STATE_ROUTE = '/api/think-summary/state';\n" + code, sandbox)
  return { sandbox, timers, document, events, subscribe: vm.runInContext('subscribeThinkState', sandbox) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('all session surfaces share one fetch, continue refinement updates, stop in background and on unmount', async () => {
  const calls = [], snapshots = []
  const c = await client(async (url, options) => {
    calls.push({ url, options })
    return { ok: true, async json() { return { enabled: true, state: { active: false, thinks: [{ segments: [{ refined: calls.length > 1 }] }] } } } }
  })
  const unsubscribers = Array.from({ length: 30 }, () => c.subscribe('session', value => snapshots.push(value)))
  await tick()
  assert.equal(calls.length, 1)
  const timer = [...c.timers].find(([, t]) => t.ms === 1500)
  assert.ok(timer)
  c.timers.delete(timer[0]); await timer[1].fn()
  assert.equal(calls.length, 2)
  assert.equal(snapshots.at(-1).state.thinks[0].segments[0].refined, true)
  c.document.hidden = true; c.events.get('visibilitychange')()
  assert.equal(c.timers.size, 0)
  c.document.hidden = false; c.events.get('visibilitychange')(); await tick()
  assert.equal(calls.length, 3)
  unsubscribers.forEach(fn => fn())
  assert.equal(c.timers.size, 0); assert.equal(c.events.size, 0)
})

test('session subscriptions are isolated and in-flight fetch aborts when last subscriber leaves', async () => {
  const signals = []
  const c = await client(async (url, options) => {
    signals.push(options.signal)
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort'))))
  })
  const a = c.subscribe('a', () => {}), b = c.subscribe('b', () => {})
  assert.equal(signals.length, 2)
  a(); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false)
  b(); await tick()
  assert.equal(c.timers.size, 0)
})

test('client bundle registers rc.3 list slots with ids and direct turn owner props', async () => {
  const registrations = []
  let module
  const sandbox = vm.createContext({ console, window: { __ModuleLoader__: { load(value) { module = value.factory(() => ({})) } } } })
  vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  module.apply({ slots: { inject(name, callback) { callback() }, register(options, component) { registrations.push({ options, component }) } } })
  assert.equal(registrations.length, 3)
  for (const { options } of registrations) {
    assert.equal(typeof options.id, 'string')
    assert.equal(options.select, undefined)
  }
  assert.equal(registrations[0].options.name, 'conversation.chat.turnTail')
})

test('304 retains the snapshot and does not notify or parse JSON', async () => {
  let calls = 0
  const values = []
  const c = await client(async (url, options) => {
    if (calls++) {
      assert.equal(options.headers['If-None-Match'], 'revision-1')
      return { status: 304, json() { assert.fail('304 must not parse') } }
    }
    return { ok: true, headers: { get: () => 'revision-1' }, async json() { return { state: { thinks: [], active: false } } } }
  })
  const unsubscribe = c.subscribe('s', v => values.push(v)); await tick()
  const snapshot = values.at(-1), count = values.length
  const [id, timer] = [...c.timers].find(([, t]) => t.ms === 5000)
  c.timers.delete(id); await timer.fn()
  assert.equal(values.length, count); assert.equal(values.at(-1), snapshot)
  assert.ok([...c.timers.values()].some(t => t.ms === 5000))
  unsubscribe()
})
