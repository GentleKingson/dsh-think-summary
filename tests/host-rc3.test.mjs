import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { Config, resolveConfig } from '../lib/host/config.js'
import { installDetect } from '../lib/host/stream.js'
import { ThinkStateStore } from '../lib/host/state.js'
import { RefineQueue } from '../lib/host/summarize/refine.js'
import { task, until } from './helpers.mjs'

test('published rc.3 LlmRuntime waterfall accepts plugin and isolated refinement requests', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const calls = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options)
      if (!options.purpose) yield { type: 'reasoning-delta', text: '中文思考。'.repeat(100) }
      yield { type: 'text-delta', text: '中文摘要' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['provider'], new Adapter())
  const store = new ThinkStateStore()
  installDetect(ctx, store, () => resolveConfig({ thinkThresholdTokens: 100 }))
  const original = []
  for await (const chunk of ctx.llm.stream({ provider: 'provider', model: 'session-model', sessionId: 'session', messages: [] })) original.push(chunk)
  assert.equal(original.length, 3)
  const applied = []
  const queue = new RefineQueue(() => ({}), () => ctx.llm, (...args) => applied.push(args))
  queue.enqueue(task()); await until(() => queue.running === 0)
  assert.equal(applied[0][3], '中文摘要')
  assert.equal(calls[1].purpose, 'think-summary')
  assert.equal(store.get('session').thinks.length, 1)
  queue.dispose()
})

test('real Cordis loads the exported volatile Config and disposes all HTTP routes', async () => {
  const ctx = new Context(), routes = new Map()
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
  const fiber = ctx.plugin(plugin, { persistEnabled: false, refineEnabled: false })
  await fiber
  assert.equal(routes.size, 2)
  await fiber.dispose()
  assert.equal(routes.size, 0)
})

test('schema enforces bounds; live values are resolved on each read', () => {
  assert.throws(() => Config({ refineConcurrency: 999 }))
  assert.throws(() => Config({ refineTimeout: 0 }))
  let value = false
  const config = { refineEnabled: { get: () => value }, refineOutputTokens: { get: () => 256 } }
  assert.equal(resolveConfig(config).refineEnabled, false)
  value = true
  assert.equal(resolveConfig(config).refineEnabled, true)
  assert.equal(resolveConfig(config).refineOutputTokens, 256)
})

test('rc.3 Loader updates volatile configuration without replacing the plugin instance', async () => {
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  const { default: Settings } = await import('@deepseek-ai/dsh-settings')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.summary = plugin
  const id = await ctx.loader.create({ id: 'think-summary', name: 'cordis:summary', config: { persistEnabled: false, refineEnabled: false } })
  const entry = ctx.loader.resolve(id)
  await entry.fiber.await()
  const fiber = entry.fiber
  const config = fiber.effectiveConfig
  ctx.provide('profileContext', { dir: await mkdtemp(join(tmpdir(), 'think-profile-')) })
  ctx.provide('configEditor', { configuration: () => [{ entry, inherited: {}, override: entry.options.config }] })
  const settingsFiber = ctx.plugin(Settings)
  await settingsFiber
  const before = ctx.settings.describe()[0]
  assert.equal(before.autoGenerate, true)
  assert.equal(before.applies, 'live')
  assert.equal(before.value.refineEnabled, false)
  await entry.update({ config: { persistEnabled: false, refineEnabled: true, refineOutputTokens: 256 } })
  await entry.fiber.await()
  assert.equal(entry.fiber, fiber)
  assert.equal(config.refineEnabled.get(), true)
  assert.equal(config.refineOutputTokens.get(), 256)
  assert.equal(ctx.settings.describe()[0].value.refineOutputTokens, 256)
  await fiber.dispose(); await settingsFiber.dispose()
})
