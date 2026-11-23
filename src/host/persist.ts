import { mkdir, readFile, rename, writeFile, unlink, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ThinkStateStore, SavedThinkState } from './state.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'
import { diagnose } from './diagnostics.js'

/** Reversible base64url with escaped capitals for case-insensitive filesystems; split long IDs. */
export function sessionFile(dir: string, sid: string) {
  const encoded = Buffer.from(sid).toString('base64url').replace(/[A-Z_]/g, c => c === '_' ? '__' : '_' + c.toLowerCase()) || '_'
  const parts = encoded.match(/.{1,120}/g)!
  return join(dir, ...parts.slice(0, -1), `${parts.at(-1)}.json`)
}

function validSession(rec: unknown): rec is SavedThinkState {
  const s = rec as SavedThinkState | null
  return !!s && typeof s.sessionId === 'string' && Array.isArray(s.thinks) && s.thinks.every(t =>
    t && typeof t.id === 'string' && Array.isArray(t.segments) && t.segments.every(seg =>
      seg && typeof seg.summary === 'string' && Number.isInteger(seg.index)))
}

/** Per-session, serialized writes. Only clean, reloadable idle sessions may leave memory. */
export async function installPersist(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig,
  pinned: (sid: string) => boolean = () => false, beforeStop: () => Promise<void> = async () => {}) {
  const home = resolveDshHome()
  const dir = join(home, 'dsh-think-summary', 'sessions')
  const legacy = join(home, 'dsh-think-summary.json')
  const dirty = new Set<string>(), loaded = new Set<string>()
  const loading = new Map<string, Promise<void>>()
  const sizes = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> | undefined
  let migration: Promise<void> | undefined
  let migrated = false, stopped = false
  const enabled = () => getOptions().persistEnabled !== false

  async function atomic(file: string, payload: string, exclusive = false) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      if (!enabled()) throw new Error('disabled')
      // Migration must never replace an existing session, even after interruption.
      if (exclusive) {
        try { await link(tmp, file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } else await rename(tmp, file)
    } finally { await unlink(tmp).catch(() => {}) }
  }
  async function migrate() {
    if (migrated || !enabled()) return
    migration ??= (async () => {
      let raw
      try { raw = await readFile(legacy, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { migrated = true; return }
        throw error
      }
      const old = JSON.parse(raw)
      if (old?.version !== 1 || !Array.isArray(old.sessions)) throw new Error('history format')
      for (const rec of old.sessions) {
        if (!validSession(rec)) throw new Error('history record')
        await atomic(sessionFile(dir, rec.sessionId), JSON.stringify({ version: 2, session: rec }), true)
      }
      // A backup is never replaced; a subsequent legacy file requires manual resolution.
      try { await link(legacy, `${legacy}.v1.bak`) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(`${legacy}.v1.bak`, 'utf8') !== raw) throw error
      }
      await unlink(legacy)
      migrated = true
    })().finally(() => { migration = undefined })
    await migration
  }
  function trimCache(retain?: string) {
    if (!enabled()) return
    const residents = store.residentIds()
    const residentSet = new Set(residents)
    for (const sid of loaded) {
      if (!residentSet.has(sid)) { loaded.delete(sid); sizes.delete(sid) }
    }
    const idle = residents.filter(sid => loaded.has(sid) && !store.get(sid)?.active && !dirty.has(sid) && !loading.has(sid) && !pinned(sid))
    let count = idle.length, bytes = idle.reduce((n, sid) => n + (sizes.get(sid) ?? 0), 0)
    for (const sid of idle) {
      if (count <= 16 && bytes <= 32 * 1024 * 1024) break
      if (sid === retain) continue
      count--; bytes -= sizes.get(sid) ?? 0
      store.evict(sid); loaded.delete(sid); sizes.delete(sid)
    }
  }
  async function load(sid: string) {
    if (!enabled() || loaded.has(sid)) return
    let job = loading.get(sid)
    if (!job) {
      job = (async () => {
        await migrate()
        if (!enabled()) return
        try {
          const raw = await readFile(sessionFile(dir, sid), 'utf8')
          const saved = JSON.parse(raw)
          if (saved?.version !== 2 || !validSession(saved.session) || saved.session.sessionId !== sid) throw new Error('history format')
          if (!enabled()) return
          store.loadAll([saved.session])
          sizes.set(sid, Buffer.byteLength(raw))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (store.get(sid)) loaded.add(sid)
      })().finally(() => { loading.delete(sid) })
      loading.set(sid, job)
    }
    await job
  }
  store.ensureLoaded = async sid => {
    try { await load(sid); trimCache(sid) } catch { diagnose('history-load') }
  }
  async function save() {
    try { await migrate() } catch { diagnose('history-migrate'); return }
    // Retry failed sessions on the next change, without spinning on a bad file.
    for (const sid of [...dirty]) {
      if (!enabled()) break
      try {
        await load(sid)
        if (!enabled()) break
        dirty.delete(sid)
        const session = store.exportAll(sid)[0]
        if (session) {
          const payload = JSON.stringify({ version: 2, session })
          await atomic(sessionFile(dir, sid), payload)
          sizes.set(sid, Buffer.byteLength(payload))
        }
      } catch { dirty.add(sid); diagnose('history-save') }
    }
    trimCache()
  }
  async function flush(): Promise<void> {
    clearTimeout(timer); timer = undefined
    if (writing) { await writing; return flush() }
    if (!enabled()) return
    writing = save().finally(() => { writing = undefined })
    await writing
  }
  const unsubscribe = store.onChange((sid, persist) => {
    if (stopped) return
    if (persist) dirty.add(sid)
    if (enabled() && persist && !timer) timer = setTimeout(() => { void flush() }, 250)
  })
  ctx.on('loader/volatile-update', async () => {
    if (stopped || !enabled()) return
    await flush()
    // Enabling history also restores sessions already in use, without manual flush.
    await Promise.all(store.residentIds().map(sid => store.ensureLoaded(sid)))
    trimCache()
  })
  ctx.effect(() => async () => {
    await beforeStop()
    stopped = true; unsubscribe(); clearTimeout(timer)
    await Promise.allSettled(loading.values())
    await flush()
  })
  await flush()
  return { flush, dir, file: (sid: string) => sessionFile(dir, sid), trimCache }
}
