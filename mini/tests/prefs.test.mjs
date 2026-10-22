import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDefaultStyle } from '../lib/prefs.ts'

test('default style accepts only a known preset id', () => {
  assert.equal(normalizeDefaultStyle('fresh', ['original', 'fresh']), 'fresh')
  assert.equal(normalizeDefaultStyle('missing', ['original', 'fresh']), null)
  assert.equal(normalizeDefaultStyle('', ['original', 'fresh']), null)
})
