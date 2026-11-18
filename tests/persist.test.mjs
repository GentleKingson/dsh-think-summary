import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThinkStateStore } from '../lib/host/state.js'
import { installPersist } from '../lib/host/persist.js'
import { context } from './helpers.mjs'

test('final refinement and turn metadata survive reload under DSH_HOME; history does not expire', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'think-history-'))
  try {
    const ctx = context(), store = new ThinkStateStore()
    const writer = await installPersist(ctx, store, () => ({}))
    const { state, think } = store.beginThink('s')
    store.pushSegment(state, think.id, { index: 0, summary: '初始', tokens: 100, refined: false, ts: 1 })
    store.endThink('s', think.id)
    store.updateSegment('s', think.id, 0, { summary: '最终中文摘要', refined: true })
    think.turn = 2; think.step = 3; store.touch('s')
    await ctx.emit('dispose')
    assert.equal(writer.file, join(process.env.DSH_HOME, 'dsh-think-summary.json'))
    assert.deepEqual((await readdir(process.env.DSH_HOME)).filter(f => f.endsWith('.tmp')), [])
    const next = new ThinkStateStore(), nextCtx = context()
    await installPersist(nextCtx, next, () => ({}))
    const restored = next.get('s').thinks[0]
    assert.equal(restored.segments[0].summary, '最终中文摘要')
    assert.equal(restored.active, false)
    assert.equal(restored.turn, 2); assert.equal(restored.step, 3)
    next.sweep(Date.now() + 365 * 86400000)
    assert.ok(next.get('s'))
    assert.equal(next.beginThink('s').think.id, 's2')
    await nextCtx.emit('dispose')
    assert.equal(JSON.parse(await readFile(writer.file, 'utf8')).version, 1)
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})

test('disabled persistence does no I/O and corrupt history cannot abort startup', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'think-disabled-'))
  try {
    const file = join(process.env.DSH_HOME, 'dsh-think-summary.json')
    await writeFile(file, '{broken')
    const ctx = context(), store = new ThinkStateStore()
    await installPersist(ctx, store, () => ({ persistEnabled: false }))
    const { state, think } = store.beginThink('s')
    store.pushSegment(state, think.id, { index: 0, summary: '文本', tokens: 10, ts: 0, refined: false })
    await ctx.emit('dispose')
    assert.equal(await readFile(file, 'utf8'), '{broken')
    await installPersist(context(), new ThinkStateStore(), () => ({}))
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})

test('malformed records are isolated and never replace live state; listeners are isolated', () => {
  const store = new ThinkStateStore()
  store.onChange(() => { throw new Error('disk') })
  let called = 0; store.onChange(() => called++)
  const { think } = store.beginThink('live')
  store.loadAll([{ sessionId: 'bad', thinks: [null, {}] }, { sessionId: 'live', thinks: [{ id: 's9', segments: [{ index: 0, summary: 'old' }] }] }])
  assert.equal(store.get('live').thinks[0].segments[0].summary, 'old')
  assert.equal(store.get('live').thinks[1], think)
  assert.equal(called, 1)
})


test('reload settles unfinished refinement instead of displaying pending forever', () => {
  const store = new ThinkStateStore()
  store.loadAll([{ sessionId: 's', nextThinkId: 1, thinks: [{ id: 's9', active: true, segments: [{ index: 0, summary: '提取摘要', refined: false }] }] }])
  assert.ok(store.get('s').thinks[0].segments[0].unrefinedReason)
  assert.equal(store.beginThink('s').think.id, 's10')
})

test('enabling persistence merges history before any concurrent flush, retaining active IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'think-enable-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  const file = join(dir, 'dsh-think-summary.json')
  const historical = new ThinkStateStore()
  for (const id of ['archive', 'active']) {
    const { state, think } = historical.beginThink(id)
    historical.pushSegment(state, think.id, { index: 0, summary: 'old', tokens: 1, refined: true, ts: 1 })
  }
  await writeFile(file, JSON.stringify({ version: 1, sessions: historical.exportAll() }))
  const ctx = context(), store = new ThinkStateStore(), config = { persistEnabled: false }
  const writer = await installPersist(ctx, store, () => config)
  assert.equal(store.get('archive'), undefined)
  const { state, think } = store.beginThink('active')
  config.persistEnabled = true
  const enabling = ctx.emit('loader/volatile-update')
  store.beginThink('empty')
  await Promise.all([enabling, writer.flush()])
  assert.deepEqual(JSON.parse(await readFile(file)).sessions.map(s => s.sessionId).sort(), ['active', 'archive'])
  assert.equal(store.get('active'), state)
  assert.equal(state.active, true)
  store.pushSegment(state, think.id, { index: 0, summary: 'new', tokens: 2, refined: false, ts: 2 })
  store.updateSegment('active', think.id, 0, { summary: 'refined', refined: true })
  config.persistEnabled = false
  await ctx.emit('loader/volatile-update')
  config.persistEnabled = true
  await ctx.emit('loader/volatile-update')
  await ctx.emit('dispose')
  const restored = new ThinkStateStore()
  restored.loadAll(JSON.parse(await readFile(file)).sessions)
  const groups = restored.get('active').thinks
  assert.deepEqual(groups.map(g => g.segments[0].summary), ['old', 'refined'])
  assert.equal(groups[1].id, think.id)
  assert.equal(new Set([...groups, restored.beginThink('active').think].map(g => g.id)).size, 3)
})
