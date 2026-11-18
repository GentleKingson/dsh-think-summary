export function context(services = {}) {
  const events = new Map()
  return {
    effect(execute) { this.on('dispose', execute()) },
    events, get: name => services[name],
    on(name, listener) { const list = events.get(name) || []; list.push(listener); events.set(name, list) },
    async emit(name, ...args) { for (const fn of events.get(name) || []) await fn(...args) },
  }
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function until(fn) {
  for (let n = 0; n < 200; n++) { if (fn()) return; await delay(5) }
  throw new Error('condition timed out')
}
export const task = (index = 0) => ({ sessionId: 'session', thinkId: 's1', segmentIndex: index, text: '测试中文摘要。'.repeat(200), provider: 'provider', fallbackModel: 'session-model' })
