import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const root = new URL('../../', import.meta.url)
const group = (id, turn, step, count = 1) => ({ id, turn, step, active: false, tokens: 100, segments: Array.from({ length: count }, (_, index) => ({ index, summary: `${id}摘要${index}` + '内容。'.repeat(40), tokens: 100, refined: true })) })
async function setup(page, initial) {
  let state = initial, rev = 1, calls = 0, unchanged = 0
  await page.route('http://test.local/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/think-summary/state') {
      calls++
      if (route.request().headers()['if-none-match'] === `"${rev}"`) { unchanged++; return route.fulfill({ status: 304 }) }
      return route.fulfill({ json: { enabled: true, paused: false, state }, headers: { etag: `"${rev}"` } })
    }
    if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><style>:root{--dsh-composer-card-max-width:800px;--dsh-composer-side-clearance:0px;--dsh-composer-dock-inset:0px}#history{height:240px;overflow:auto}</style><div id="dock"></div><div id="tail"></div><div id="history"></div>` })
    const files = { '/react.js': 'node_modules/react/umd/react.development.js', '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js', '/client.js': 'lib/client.js' }
    if (files[path]) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL(files[path], root), 'utf8') })
    return route.abort()
  })
  await page.goto('http://test.local/')
  await page.addScriptTag({ url: '/react.js' }); await page.addScriptTag({ url: '/react-dom.js' })
  await page.evaluate(() => {
    window.components = {}
    window.__ModuleLoader__ = { load(value) { value.factory(() => window.React).apply({ slots: {
      inject(name, cb) { cb() }, register(options, component) { window.components[options.id] = component },
    }, effect() {} }) } }
  })
  await page.addScriptTag({ url: '/client.js' })
  await page.evaluate(() => {
    window.roots = Object.fromEntries(['dock', 'tail', 'history'].map(id => [id, ReactDOM.createRoot(document.getElementById(id))]))
    window.render = (sessionId = 's', turn = 1) => {
      roots.dock.render(React.createElement(components['think-summary.dock'], { sessionId }))
      roots.tail.render(React.createElement(components['think-summary.tail'], { sessionId, turn: { turn } }))
      roots.history.render(React.createElement(components['think-summary'], { sessionId }))
    }
    window.render()
  })
  return { set(next) { state = next; rev++ }, counts: () => ({ calls, unchanged }) }
}
const snapshot = (thinks, currentTurn = 1) => ({ sessionId: 's', currentTurn, thinks, active: true, thinkingTokens: 100 })

test('dock sorts steps, switches turns, locates newest segment and survives collapse', async ({ page }) => {
  const app = await setup(page, snapshot([group('later', 1, 2), group('earlier', 1, 1)]))
  await expect(page.locator('.ts-dock-seg-text').first()).toContainText('earlier摘要')
  await expect(page.locator('.ts-dock-seg-text').last()).toContainText('later摘要')
  await page.locator('.ts-dock-toggle').click()
  app.set(snapshot([group('next', 2, 1, 8)], 2))
  await expect(page.locator('#history')).toContainText('next摘要')
  await page.locator('.ts-dock-toggle').click()
  await expect(page.locator('#dock')).not.toContainText('earlier摘要')
  await expect(page.locator('.ts-dock-seg-text').last()).toContainText('next摘要7')
  expect(await page.locator('.ts-dock-body').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  const bottomGap = await page.locator('.ts-dock-seg').last().evaluate(el => {
    const body = el.parentElement
    return el.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight
  })
  expect(bottomGap).toBeLessThan(1)
})

test('tail refreshes refinement; 304 avoids DOM changes; switching sessions and unmount stop old subscriptions', async ({ page }) => {
  const g = group('first', 1, 1); g.segments[0].refined = false
  const app = await setup(page, snapshot([g]))
  await page.locator('.ts-tail-head').click()
  await expect(page.locator('.ts-tail-body')).toContainText('待精炼')
  const refined = structuredClone(g); refined.segments[0].refined = true; refined.segments[0].summary = '精炼完成'
  app.set(snapshot([refined]))
  await expect(page.locator('.ts-tail-body')).toContainText('精炼完成')
  await page.evaluate(() => { window.mutations = 0; new MutationObserver(() => window.mutations++).observe(document.getElementById('dock'), { childList: true, subtree: true, characterData: true }) })
  await expect.poll(() => app.counts().unchanged).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.mutations)).toBe(0)
  app.set({ ...snapshot([group('other', 2, 1)], 2), sessionId: 'other' })
  await page.evaluate(() => window.render('other', 2))
  await expect(page.locator('#dock')).toContainText('other摘要')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenCount = app.counts().calls
  await page.waitForTimeout(1800)
  expect(app.counts().calls).toBe(hiddenCount)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => app.counts().calls).toBeGreaterThan(hiddenCount)
  await page.evaluate(() => Object.values(window.roots).forEach(root => root.unmount()))
  const count = app.counts().calls
  await page.waitForTimeout(1800)
  expect(app.counts().calls).toBe(count)
})

test('history follows only at bottom and resets following when changing session', async ({ page }) => {
  const groups = Array.from({ length: 12 }, (_, i) => group(`s${i}`, 1, i))
  const app = await setup(page, snapshot(groups))
  await expect(page.locator('.ts-view-card')).toHaveCount(12)
  await expect.poll(() => page.locator('#history').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await page.locator('#history').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  app.set(snapshot([...groups, group('added', 1, 12)]))
  await expect(page.locator('.ts-view-card')).toHaveCount(13)
  expect(await page.locator('#history').evaluate(el => el.scrollTop)).toBe(0)
  await page.locator('#history').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
  app.set(snapshot([...groups, group('added', 1, 12), group('last', 1, 13)]))
  await expect(page.locator('.ts-view-card')).toHaveCount(14)
  await expect.poll(() => page.locator('#history').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(30)
  await page.locator('#history').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  app.set({ ...snapshot(groups), sessionId: 'other' }); await page.evaluate(() => window.render('other'))
  await expect(page.locator('.ts-view-card')).toHaveCount(12)
  await expect.poll(() => page.locator('#history').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
})
