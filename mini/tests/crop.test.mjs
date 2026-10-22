import assert from 'node:assert/strict'
import test from 'node:test'
import { cropRect, rotateSize } from '../lib/image/crop.ts'

test('1:1 crop is centered inside the source', () => {
  assert.deepEqual(cropRect(1200, 800, '1:1'), {
    x: 200, y: 0, w: 800, h: 800,
  })
})

test('4:5 crop keeps full height for a landscape source', () => {
  assert.deepEqual(cropRect(1200, 800, '4:5'), {
    x: 280, y: 0, w: 640, h: 800,
  })
})

test('16:9 crop keeps full width for a portrait source', () => {
  assert.deepEqual(cropRect(800, 1200, '16:9'), {
    x: 0, y: 375, w: 800, h: 450,
  })
})

test('original ratio preserves dimensions', () => {
  assert.deepEqual(cropRect(801, 599, 'original'), {
    x: 0, y: 0, w: 801, h: 599,
  })
})

test('quarter turns swap dimensions on odd turns', () => {
  assert.deepEqual(rotateSize(1201, 799, 0), { width: 1201, height: 799 })
  assert.deepEqual(rotateSize(1201, 799, 1), { width: 799, height: 1201 })
  assert.deepEqual(rotateSize(1201, 799, 2), { width: 1201, height: 799 })
  assert.deepEqual(rotateSize(1201, 799, 3), { width: 799, height: 1201 })
})
