import assert from 'node:assert/strict'
import test from 'node:test'
import { modelLabelOf } from '../lib/status.ts'

test('modelLabelOf prefers the active image model alias', () => {
  assert.equal(modelLabelOf([
    { kind: 'chat', active: true, alias: 'chat', modelId: 'chat-1' },
    { kind: 'image', active: true, alias: '修图模型', modelId: 'image-1' },
  ]), '修图模型')
})

test('modelLabelOf falls back without exposing ids when no image model is active', () => {
  assert.equal(modelLabelOf([
    { kind: 'image', active: false, alias: '备用', modelId: 'image-2' },
  ]), '未单独配置（使用服务端默认）')
})
