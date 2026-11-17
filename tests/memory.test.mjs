import test from 'node:test'
import assert from 'node:assert/strict'
import { Segmenter } from '../lib/host/segment.js'

test('punctuation-free lines and atomic code blocks retain bounded buffers', () => {
  for (const codeMode of ['ignore', 'keep']) {
    const segmenter = new Segmenter({ codeMode }, () => {})
    segmenter.feed('```js\n')
    for (let n = 0; n < 100; n++) segmenter.feed('x'.repeat(10_000))
    assert.ok(segmenter.pending.length <= 65_536)
    assert.ok(segmenter.buf.length <= 200_000)
    segmenter.feed('\n```\n'); segmenter.flush()
  }
})
