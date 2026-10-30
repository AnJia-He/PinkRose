// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyPresetToSchema, deleteCameraPreset, loadCameraPresets,
  MAX_CAMERA_PRESETS, saveCameraPreset,
} from './cameraPresets.ts'

beforeEach(() => localStorage.clear())

describe('相机拍摄参数预设', () => {
  it('保存 / 同名覆盖 / 删除', () => {
    saveCameraPreset('棚拍', 'Canon EOS R5', { iso: 400, shutter: '1/125' })
    saveCameraPreset('棚拍', 'Canon EOS R5', { iso: 800, shutter: '1/250' })
    expect(loadCameraPresets()).toHaveLength(1)
    expect(loadCameraPresets()[0]!.settings).toEqual({ iso: 800, shutter: '1/250' })
    expect(deleteCameraPreset(loadCameraPresets()[0]!.id)).toEqual([])
  })

  it('只应用当前 schema 支持且合法的项；数字按步长和范围钳制', () => {
    const preset = {
      id: 'p1', name: '棚拍', model: 'X', createdAt: 0,
      settings: { iso: 777, shutter: '1/250', aperture: 99, wb: 'daylight', unknown: 1 },
    }
    const patch = applyPresetToSchema(preset, [
      { key: 'iso', type: 'number', min: 100, max: 6400, step: 100 },
      { key: 'shutter', type: 'select', options: [{ value: '1/125' }, { value: '1/250' }] },
      { key: 'aperture', type: 'number', min: 1.4, max: 16, step: 0.1 },
      { key: 'wb', type: 'select', options: [{ value: 'auto' }] },
      { key: 'readonly', type: 'number', readOnly: true },
    ], { iso: 400, shutter: '1/125', aperture: 2.8, wb: 'auto', readonly: 1 })
    expect(patch).toEqual({ iso: 800, shutter: '1/250', aperture: 16 })
  })

  it('最多 20 条，坏数据不崩', () => {
    localStorage.setItem('pinkrose.cameraPresets.v1', '{bad')
    expect(loadCameraPresets()).toEqual([])
    for (let i = 0; i < MAX_CAMERA_PRESETS + 3; i++) {
      saveCameraPreset(`预设 ${i}`, 'X', { iso: i })
    }
    expect(loadCameraPresets()).toHaveLength(MAX_CAMERA_PRESETS)
  })
})
