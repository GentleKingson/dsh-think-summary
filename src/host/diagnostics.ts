/** Fixed categories only: never log provider errors, IDs, credentials or source text. */
export type Diagnostic = 'stream-observer' | 'fallback-observer' | 'route-register' | 'history-load' | 'history-save' | 'history-migrate' | 'state-observer'
export function createDiagnostics(log: (message: string) => void = console.warn, now = Date.now) {
  const last = new Map<Diagnostic, number>()
  return (category: Diagnostic) => {
    const time = now()
    if (time - (last.get(category) ?? -Infinity) < 60_000) return
    last.set(category, time)
    log(`[dsh-think-summary] ${category} failed; original data preserved where possible`)
  }
}
export const diagnose = createDiagnostics()
