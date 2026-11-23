import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnostics } from '../lib/host/diagnostics.js'
test('fixed diagnostic categories are independently rate limited', () => {
  let time = 0
  const messages = [], report = createDiagnostics(s => messages.push(s), () => time)
  report('history-load'); report('history-load'); report('stream-observer')
  assert.equal(messages.length, 2)
  time = 60_000; report('history-load')
  assert.equal(messages.length, 3)
  assert.ok(messages.every(m => !m.includes('secret-token')))
})
