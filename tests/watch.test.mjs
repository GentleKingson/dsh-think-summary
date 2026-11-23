import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

test('watch passes valid compiler args and terminates its sibling on worker failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'think-watch-'))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true })
  await copyFile(new URL('../scripts/watch-all.mjs', import.meta.url), join(root, 'scripts/watch-all.mjs'))
  await writeFile(join(root, 'node_modules/typescript/bin/tsc'), "console.log(JSON.stringify(process.argv.slice(2))); setTimeout(() => process.exit(2), 200)")
  await writeFile(join(root, 'scripts/watch-client.mjs'), "setInterval(() => {}, 1000)")
  const child = spawn(process.execPath, [join(root, 'scripts/watch-all.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; child.stdout.on('data', data => out += data)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 1)
    assert.deepEqual(JSON.parse(out.trim()), ['-p', 'tsconfig.json', '--watch'])
  } finally { clearTimeout(timeout) }
})
