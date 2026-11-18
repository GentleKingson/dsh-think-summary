import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ThinkStateStore } from './state.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/** One serialized, coalescing writer; stream observers only mark the store dirty. */
export async function installPersist(ctx: CtxLike, store: ThinkStateStore, getOptions: () => ThinkSummaryConfig) {
  const dir = resolveDshHome()
  const file = join(dir, 'dsh-think-summary.json')
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> | undefined
  let stopped = false
  let loaded = false
  const enabled = () => getOptions().persistEnabled !== false

  const save = async () => {
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'))
        if (!enabled()) return
        if (saved?.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('Unknown history format')
        store.loadAll(saved.sessions)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[dsh-think-summary] history load failed; preserving existing file')
          return
        }
      }
      loaded = true
    }
    while (dirty && enabled()) {
      dirty = false
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        const payload = JSON.stringify({ version: 1, sessions: store.exportAll() })
        await mkdir(dir, { recursive: true })
        await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        if (!enabled()) { dirty = true; return }
        await rename(tmp, file)
      } catch {
        dirty = true
        console.warn('[dsh-think-summary] history save failed; will retry on next change')
        return
      } finally { await unlink(tmp).catch(() => {}) }
    }
  }

  const flush = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (writing) await writing
    if (!enabled() || (loaded && !dirty)) return
    writing ??= save().finally(() => { writing = undefined })
    await writing
  }
  await flush()
  const unsubscribe = store.onChange(() => {
    if (stopped) return
    dirty = true
    if (enabled() && !timer) timer = setTimeout(() => { void flush().catch(() => {}) }, 250)
  })
  ctx.on('loader/volatile-update', () => { if (!stopped) return flush() })
  ctx.effect(() => async () => {
    stopped = true
    unsubscribe()
    await flush()
  })
  return { flush, file }
}
