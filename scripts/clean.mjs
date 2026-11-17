import { rmSync } from 'node:fs'
// Never ship obsolete modules left behind by deleted TypeScript sources.
rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })
