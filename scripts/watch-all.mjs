/** Build both halves; an unexpected worker exit stops the entire watch session. */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const children = new Set()
let stopping = false
function stop(code, signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill(signal)
}
function run(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' })
  children.add(child)
  child.on('error', () => { console.error(`[watch-all] ${label} could not start`); stop(1) })
  child.on('exit', () => {
    children.delete(child)
    if (!stopping) { console.error(`[watch-all] ${label} exited unexpectedly`); stop(1) }
  })
}
// Invoke the compiler JS directly: no platform shell or npx process to orphan.
run('tsc --watch', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--watch'])
run('watch-client', process.execPath, [join(root, 'scripts/watch-client.mjs')])
process.on('SIGINT', () => stop(0, 'SIGINT'))
process.on('SIGTERM', () => stop(0))
