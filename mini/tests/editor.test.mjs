import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PORTRAIT_KEYS, TONE_GROUPS, mixPreset, resetKeys, rowsForTool, setAdjustment,
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

test('tone rows expose labels and current values', () => {
  const rows = rowsForTool('tone', 'basic', { ...zero, exposure: 24 })
  assert.deepEqual(rows.map(row => [row.key, row.label, row.value]), [
    ['exposure', '亮度', 24],
    ['contrast', '对比度', 0],
    ['saturation', '饱和度', 0],
  ])
})

test('portrait rows expose the three skin controls', () => {
  const rows = rowsForTool('portrait', 'basic', {
    ...zero, skinSmooth: 35, skinBrighten: 20, skinRosy: 12,
  })
  assert.deepEqual(rows.map(row => [row.key, row.label, row.value]), [
    ['skinSmooth', '磨皮', 35],
    ['skinBrighten', '美白', 20],
    ['skinRosy', '红润', 12],
  ])
})

test('setAdjustment clamps to the shared parameter range', () => {
  assert.equal(setAdjustment(zero, 'exposure', 160).exposure, 100)
  assert.equal(setAdjustment(zero, 'exposure', -160).exposure, -100)
  assert.equal(setAdjustment(zero, 'skinSmooth', 160).skinSmooth, 100)
})
