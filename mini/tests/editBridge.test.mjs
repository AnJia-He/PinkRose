import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.wx = {
  getStorageSync(key) { return store.get(key) ?? '' },
  setStorageSync(key, value) { store.set(key, value) },
  removeStorageSync(key) { store.delete(key) },
}

const { consumePendingEdit, requestEdit } = await import('../lib/editBridge.ts')

test('a work can be handed from the works tab to the editor exactly once', () => {
  store.clear()
  const work = {
    id: '1', file: '/works/w1.jpg', thumb: '/works/w1t.jpg',
    w: 1200, h: 800, bytes: 1000, at: 1,
  }
  requestEdit(work)
  assert.deepEqual(consumePendingEdit(), work)
  assert.equal(consumePendingEdit(), null)
})

test('malformed bridge records are ignored and cleared', () => {
  store.set('pinkrose:edit-work:v1', { file: '' })
  assert.equal(consumePendingEdit(), null)
  assert.equal(store.has('pinkrose:edit-work:v1'), false)
})
