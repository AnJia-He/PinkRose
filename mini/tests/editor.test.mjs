import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PORTRAIT_KEYS, TONE_GROUPS, mixPreset, resetKeys,
} from '../lib/editor.ts'

const zero = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  clarity: 0,
  vignette: 0,
  skinSmooth: 0,
  skinBrighten: 0,
  skinRosy: 0,
}

test('resetKeys only resets the requested group', () => {
  const current = { ...zero, exposure: 20, contrast: 12, skinSmooth: 40 }
  const next = resetKeys(current, TONE_GROUPS.basic)
  assert.equal(next.exposure, 0)
  assert.equal(next.contrast, 0)
  assert.equal(next.skinSmooth, 40)
})

test('portrait group contains the three supported controls', () => {
  assert.deepEqual([...PORTRAIT_KEYS], ['skinSmooth', 'skinBrighten', 'skinRosy'])
})

test('mixPreset clamps amount and scales all preset fields', () => {
  const preset = { ...zero, exposure: 40, skinSmooth: 60 }
  assert.equal(mixPreset(50, preset).exposure, 20)
  assert.equal(mixPreset(50, preset).skinSmooth, 30)
  assert.equal(mixPreset(150, preset).exposure, 40)
  assert.equal(mixPreset(-20, preset).exposure, 0)
})
