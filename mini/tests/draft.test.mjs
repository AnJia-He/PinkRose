import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDraft } from '../lib/draft.ts'

const zero = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, temperature: 0, tint: 0,
  vibrance: 0, saturation: 0, clarity: 0, vignette: 0,
  skinSmooth: 0, skinBrighten: 0, skinRosy: 0,
}

test('normalizeDraft keeps a valid recent draft', () => {
  const now = 1_800_000_000_000
  const value = {
    version: 1,
    photoPath: '/draft/current.jpg',
    width: 1200,
    height: 800,
    params: { ...zero, exposure: 20, skinSmooth: 35 },
    presetId: 'fresh',
    styleAmount: 60,
    at: now - 1000,
  }
  assert.deepEqual(normalizeDraft(value, zero, now), value)
})

test('normalizeDraft rejects stale drafts', () => {
  const now = 1_800_000_000_000
  assert.equal(normalizeDraft({
    version: 1,
    photoPath: '/draft/current.jpg',
    width: 1200,
    height: 800,
    params: zero,
    presetId: null,
    styleAmount: 100,
    at: now - 8 * 24 * 60 * 60 * 1000,
  }, zero, now), null)
})

test('normalizeDraft rejects malformed records and fills missing params', () => {
  const now = 1_800_000_000_000
  assert.equal(normalizeDraft(null, zero, now), null)
  assert.equal(normalizeDraft({
    version: 1,
    photoPath: '',
    width: 0,
    height: 800,
    params: {},
    presetId: null,
    styleAmount: 100,
    at: now,
  }, zero, now), null)
  assert.deepEqual(normalizeDraft({
    version: 1,
    photoPath: '/draft/current.jpg',
    width: 1200,
    height: 800,
    params: { exposure: 12 },
    presetId: null,
    styleAmount: 100,
    at: now,
  }, zero, now)?.params, { ...zero, exposure: 12 })
})
