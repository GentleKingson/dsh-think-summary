import test from 'node:test'
import assert from 'node:assert/strict'
import { Segmenter } from '../lib/host/segment.js'

test('oversized atomic code is truncated for output, ignored code never reaches the sink', () => {
  for (const codeMode of ['ignore', 'keep']) {
    const pieces = []
    const segmenter = new Segmenter({ codeMode }, text => pieces.push(text))
    segmenter.feed('```js\n')
    for (let n = 0; n < 100; n++) segmenter.feed('x'.repeat(10_000))
    segmenter.feed('\n```\n'); segmenter.flush()
    if (codeMode === 'ignore') assert.deepEqual(pieces, [])
    else {
      assert.equal(pieces.length, 1)
      assert.ok(pieces[0].startsWith('```js'))
      assert.ok(pieces[0].length <= 200_000)
    }
  }
})
