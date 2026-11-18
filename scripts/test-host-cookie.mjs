import assert from 'node:assert/strict'
import * as Connection from '@deepseek-ai/dsh-client-connection'

// Standalone test hosts have no profile credential store or index page.
// Use the real rc.3 launch-token exchange with an ephemeral signing secret.
export async function testHostCookie(ctx) {
  ctx.provide('credentials', { modifyRecord: (_key, update) => update(undefined) })
  await ctx.plugin(Connection)
  const origin = ctx.webServer.getOrigin()
  const dispose = ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
    if (ctx.connection.authorizeIndex(req, res)) res.end()
  } })
  try {
    const response = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    assert.equal(response.status, 303)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return cookie
  } finally { dispose() }
}
