import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ThinkStateStore } from '../lib/host/state.js'
import { installPersist, sessionFile } from '../lib/host/persist.js'
import { context } from './helpers.mjs'

async function home(t) {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'think-history-'))
  const dir = process.env.DSH_HOME
  t.after(async () => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(dir, { recursive: true, force: true }) })
  return dir
}
function add(store, sid, summary = '摘要') {
  const { state, think } = store.beginThink(sid)
  store.pushSegment(state, think.id, { index: 0, summary, tokens: 100, refined: true, ts: 1 })
  store.endThink(sid, think.id)
  return think
}
async function legacy(root, store) {
  const file = join(root, 'dsh-think-summary.json')
  await writeFile(file, JSON.stringify({ version: 1, sessions: store.exportAll() }))
  return file
}

test('final refinement and turn metadata survive lazy reload and idle cache eviction', async t => {
  await home(t)
  const store = new ThinkStateStore(), ctx = context()
  const writer = await installPersist(ctx, store, () => ({}))
  const think = add(store, 's', '初始'); think.turn = 2; think.step = 3
  store.updateSegment('s', think.id, 0, { summary: '最终中文摘要' })
  await ctx.emit('dispose')
  assert.deepEqual((await readdir(writer.dir)).filter(f => f.endsWith('.tmp')), [])
  const next = new ThinkStateStore(), nextCtx = context()
  await installPersist(nextCtx, next, () => ({}))
  assert.equal(next.get('s'), undefined)
  await next.ensureLoaded('s')
  const restored = next.get('s').thinks[0]
  assert.equal(restored.segments[0].summary, '最终中文摘要')
  assert.equal(restored.active, false); assert.equal(restored.turn, 2); assert.equal(restored.step, 3)
  assert.equal(next.beginThink('s').think.id, 's2')
  await nextCtx.emit('dispose')
  assert.equal(JSON.parse(await readFile(writer.file('s'))).version, 2)
})

test('migration retains backup, existing v2 takes precedence and startup stays lazy', async t => {
  const root = await home(t), old = new ThinkStateStore()
  add(old, 's', 'legacy'); add(old, 'other')
  const file = await legacy(root, old)
  const dir = join(root, 'dsh-think-summary', 'sessions')
  await mkdir(dir, { recursive: true })
  const newer = new ThinkStateStore(); add(newer, 's', 'newer')
  await writeFile(sessionFile(dir, 's'), JSON.stringify({ version: 2, session: newer.exportAll()[0] }))
  // Simulate interruption after the backup link but before removal of the old file.
  await writeFile(file + '.v1.bak', await readFile(file))
  const store = new ThinkStateStore(), ctx = context()
  await installPersist(ctx, store, () => ({}))
  assert.equal(store.get('s'), undefined)
  await Promise.all([store.ensureLoaded('s'), store.ensureLoaded('s')])
  assert.equal(store.get('s').thinks[0].segments[0].summary, 'newer')
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(file + '.v1.bak')).version, 1)
  await store.ensureLoaded('other'); assert.ok(store.get('other'))
  await ctx.emit('dispose')
})

test('disabled persistence does no I/O; corrupt old and per-session files remain unchanged', async t => {
  const root = await home(t), file = join(root, 'dsh-think-summary.json')
  await writeFile(file, '{broken')
  const ctx = context(), store = new ThinkStateStore(), opts = { persistEnabled: false }
  const writer = await installPersist(ctx, store, () => opts)
  add(store, 's'); await writer.flush()
  assert.equal(await readFile(file, 'utf8'), '{broken')
  await assert.rejects(stat(writer.dir), { code: 'ENOENT' })
  opts.persistEnabled = true; await ctx.emit('loader/volatile-update')
  assert.equal(await readFile(file, 'utf8'), '{broken')
  await ctx.emit('dispose')
})

test('hot enabling merges concurrent live state without a manual flush or changing active IDs', async t => {
  const root = await home(t), old = new ThinkStateStore(); add(old, 'active', 'old')
  await legacy(root, old)
  const store = new ThinkStateStore(), ctx = context(), opts = { persistEnabled: false }
  const writer = await installPersist(ctx, store, () => opts)
  const { state, think } = store.beginThink('active')
  opts.persistEnabled = true
  const enabling = ctx.emit('loader/volatile-update')
  store.pushSegment(state, think.id, { index: 0, summary: 'new', tokens: 1, refined: false, ts: 1 })
  await enabling
  assert.equal(store.get('active'), state); assert.equal(think.id, 's1'); assert.equal(state.active, true)
  assert.deepEqual(state.thinks.map(g => g.segments[0].summary), ['old', 'new'])
  store.updateSegment('active', think.id, 0, { summary: 'refined', refined: true })
  await ctx.emit('dispose')
  assert.deepEqual(JSON.parse(await readFile(writer.file('active'))).session.thinks.map(g => g.segments[0].summary), ['old', 'refined'])
})

test('writes affect only dirty sessions; clean sessions evict and reload, active and pinned stay', async t => {
  await home(t)
  const store = new ThinkStateStore(), ctx = context()
  const writer = await installPersist(ctx, store, () => ({}), sid => sid === 'pinned')
  const pinned = add(store, 'pinned')
  add(store, 'unchanged'); await writer.flush()
  const unchanged = await stat(writer.file('unchanged'))
  store.touch('unchanged', false); await writer.flush()
  assert.equal((await stat(writer.file('unchanged'))).mtimeMs, unchanged.mtimeMs)
  for (let i = 0; i < 40; i++) add(store, `s${i}`)
  store.beginThink('active')
  await writer.flush()
  assert.ok(store.get('pinned')); assert.ok(store.get('active'))
  assert.ok(store.residentIds().length <= 18)
  assert.equal((await stat(writer.file('unchanged'))).mtimeMs, unchanged.mtimeMs)
  await store.ensureLoaded('s0'); assert.equal(store.get('s0').thinks[0].segments[0].summary, '摘要')
  store.updateSegment('pinned', pinned.id, 0, { summary: 'later' }); await writer.flush()
  assert.equal((await stat(writer.file('unchanged'))).mtimeMs, unchanged.mtimeMs)
  await ctx.emit('dispose')
})

test('malformed session files block replacement and do not prevent other sessions saving', async t => {
  await home(t)
  const ctx = context(), store = new ThinkStateStore(), writer = await installPersist(ctx, store, () => ({}))
  await mkdir(writer.dir, { recursive: true }); await writeFile(writer.file('bad'), '{broken')
  add(store, 'bad'); add(store, 'good'); await writer.flush()
  assert.equal(await readFile(writer.file('bad'), 'utf8'), '{broken')
  assert.equal(JSON.parse(await readFile(writer.file('good'))).session.sessionId, 'good')
  await ctx.emit('dispose')
})

test('long and path-like IDs use reversible, safe filesystem components', async t => {
  await home(t)
  const ctx = context(), store = new ThinkStateStore(), writer = await installPersist(ctx, store, () => ({}))
  assert.notEqual(writer.file('aa').toLowerCase(), writer.file('aG').toLowerCase())
  const sid = '../目录/'.repeat(40); add(store, sid); await writer.flush()
  assert.equal(JSON.parse(await readFile(writer.file(sid))).session.sessionId, sid)
  assert.ok(dirname(writer.file(sid)).startsWith(writer.dir))
  await ctx.emit('dispose')
})

test('reload settles unfinished refinement and isolates malformed records', () => {
  const store = new ThinkStateStore()
  store.loadAll([{ sessionId: 'bad', thinks: [null, {}] }, { sessionId: 's', thinks: [{ id: 's9', segments: [{ index: 0, summary: 'old', refined: false }] }] }])
  assert.equal(store.get('bad'), undefined)
  assert.ok(store.get('s').thinks[0].segments[0].unrefinedReason)
  assert.equal(store.beginThink('s').think.id, 's10')
})

test('byte budget evicts oversized idle history; disabled persistence retains unsaved history', async t => {
  await home(t)
  const store = new ThinkStateStore(), ctx = context(), opts = { persistEnabled: true }
  const writer = await installPersist(ctx, store, () => opts)
  add(store, 'large-a', 'x'.repeat(17 * 1024 * 1024))
  add(store, 'large-b', 'y'.repeat(17 * 1024 * 1024))
  await writer.flush()
  assert.equal(store.residentIds().length, 1)
  await store.ensureLoaded('large-a')
  assert.equal(store.residentIds().length, 1)
  assert.equal(store.get('large-a').thinks[0].segments[0].summary.length, 17 * 1024 * 1024)
  opts.persistEnabled = false
  for (let i = 0; i < 20; i++) add(store, `memory-${i}`)
  writer.trimCache()
  assert.ok(store.residentIds().length >= 20)
  await ctx.emit('dispose')
})

test('invalid migration leaves source untouched and retries idempotently after repair', async t => {
  const root = await home(t), original = new ThinkStateStore(); add(original, 'good')
  const file = join(root, 'dsh-think-summary.json')
  const sessions = [...original.exportAll(), { sessionId: 'bad', thinks: [null] }]
  await writeFile(file, JSON.stringify({ version: 1, sessions }))
  const ctx = context(), store = new ThinkStateStore(), writer = await installPersist(ctx, store, () => ({}))
  assert.equal(JSON.parse(await readFile(file)).sessions.length, 2)
  await assert.rejects(stat(file + '.v1.bak'), { code: 'ENOENT' })
  await writeFile(file, JSON.stringify({ version: 1, sessions: original.exportAll() }))
  await writer.flush(); await store.ensureLoaded('good')
  assert.equal(store.get('good').thinks.length, 1)
  assert.ok(await stat(file + '.v1.bak'))
  await ctx.emit('dispose')
})


test('unload settles side work before taking the final disk snapshot', async t => {
  await home(t)
  const ctx = context(), store = new ThinkStateStore()
  let think
  const writer = await installPersist(ctx, store, () => ({}), () => false, async () => {
    await new Promise(resolve => setImmediate(resolve))
    store.updateSegment('s', think.id, 0, { summary: 'settled', refined: true })
  })
  think = add(store, 's', 'pending')
  await ctx.emit('dispose')
  assert.equal(JSON.parse(await readFile(writer.file('s'))).session.thinks[0].segments[0].summary, 'settled')
})
