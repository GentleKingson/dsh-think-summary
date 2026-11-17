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
  if (getOptions().persistEnabled !== false) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'))
      if (saved.version === 1) store.loadAll(saved.sessions)
    } catch { /* Missing/corrupt data cannot stop the host. */ }
  }
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (writing) { await writing; if (dirty) await flush(); return }
    if (!dirty || getOptions().persistEnabled === false) { dirty = false; return }
    dirty = false
    const tmp = `${file}.${randomUUID()}.tmp`
    const payload = JSON.stringify({ version: 1, sessions: store.exportAll() })
    writing = (async () => {
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await rename(tmp, file)
      } catch {
        dirty = true
        console.warn('[dsh-think-summary] history save failed; will retry on next change')
      } finally { await unlink(tmp).catch(() => {}) }
    })()
    await writing
    writing = undefined
  }
  const unsubscribe = store.onChange(() => {
    if (stopped || getOptions().persistEnabled === false) return
    dirty = true
    if (!timer) timer = setTimeout(() => { void flush().catch(() => {}) }, 250)
  })
  ctx.effect(() => async () => {
    stopped = true
    unsubscribe()
    await flush()
  })
  return { flush, file }
}
