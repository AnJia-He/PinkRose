// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS } from './save.ts'
import { EXPORT_DEFAULTS_KEY, loadExportDefaults, saveExportDefaults } from './prefs.ts'

beforeEach(() => localStorage.clear())

describe('导出偏好', () => {
  it('没有存过 / 坏数据都回默认，不让界面变成空白', () => {
    expect(loadExportDefaults()).toEqual(DEFAULT_EXPORT_OPTIONS)
    localStorage.setItem(EXPORT_DEFAULTS_KEY, '{not json')
    expect(loadExportDefaults()).toEqual(DEFAULT_EXPORT_OPTIONS)
  })

  it('存下来再读回来：格式 / 质量 / 尺寸 / 比例 / 拍摄信息 / GPS / 色彩空间都在', () => {
    saveExportDefaults({
      format: 'image/webp',
      qualityPct: 82,
      longEdge: 2048,
      aspect: '4:5',
      fit: 'blur',
      preserveMetadata: false,
      preserveLocation: false,
      colorSpace: 'display-p3',
      creator: '  Photographer A  ',
      copyright: '  © 2026 Photographer A  ',
    })
    expect(loadExportDefaults()).toEqual({
      format: 'image/webp',
      qualityPct: 82,
      longEdge: 2048,
      aspect: '4:5',
      fit: 'blur',
      preserveMetadata: false,
      preserveLocation: false,
      colorSpace: 'display-p3',
      creator: 'Photographer A',
      copyright: '© 2026 Photographer A',
    })
  })

  it('TIFF 是合法默认格式，不会被回退成 JPG', () => {
    saveExportDefaults({ ...DEFAULT_EXPORT_OPTIONS, format: 'image/tiff' })
    expect(loadExportDefaults().format).toBe('image/tiff')
  })

  it('脏值钳回安全范围，认不出的枚举回默认', () => {
    localStorage.setItem(EXPORT_DEFAULTS_KEY, JSON.stringify({
      format: 'image/bmp',
      qualityPct: 500,
      longEdge: -4,
      aspect: '7:3',
      fit: 'stretch',
      preserveMetadata: 'yes',
    }))
    expect(loadExportDefaults()).toEqual({
      ...DEFAULT_EXPORT_OPTIONS,
      qualityPct: 100,
      longEdge: null,
    })
  })
})
