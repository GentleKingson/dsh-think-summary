import { readFileSync } from 'node:fs'
const s = readFileSync('lib/client.js', 'utf8')
const keys = [
  'function makeInputDock',
  'function makeThinkSummaryView',
  "slots.inject('conversation.chat.turnTail'",
  "slots.inject('conversation.view'",
  "slots.inject('conversation.input.dock'",
]
const idx = keys.map((k) => s.indexOf(k))
console.log(idx.join(' < '))
console.log(idx.every((v, i, a) => i === 0 || v > a[i - 1]) ? '模块顺序正确 ✅' : '顺序错误 ✗')

if (idx.some((v, i) => v < 0 || (i > 0 && v <= idx[i - 1]))) process.exitCode = 1
