import { describe, expect, it, vi } from 'vitest'
import {
  clearBatchPrefs, DEFAULT_BATCH_PREFS, loadBatchPrefs, normalizeBatchPrefs, saveBatchPrefs,
} from './prefs.ts'

describe('批量工作流偏好', () => {
  it('只接受已知画幅、方向、命名和布尔开关', () => {
    expect(normalizeBatchPrefs({
      aspect: '4:5', orientation: 'left', autoEnhance: true,
      autoLens: 'yes', smartCrop: true, nameMode: 'date', namePrefix: 'Trip',
    })).toEqual({
      aspect: '4:5', orientation: 'left', autoEnhance: true,
      autoLens: false, smartCrop: true, nameMode: 'date', namePrefix: 'Trip',
    })
    expect(normalizeBatchPrefs({
      aspect: 'bad', orientation: 'bad', nameMode: 'bad', namePrefix: 4,
    })).toEqual(DEFAULT_BATCH_PREFS)
  })

  it('保存、恢复和清除使用同一个本机键', () => {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
        removeItem: (key: string) => { store.delete(key) },
      },
    })
    try {
      saveBatchPrefs({
        ...DEFAULT_BATCH_PREFS,
        aspect: '16:9',
        orientation: 'flip180',
        autoLens: true,
        nameMode: 'sequence',
        namePrefix: 'Event',
      })
      expect(loadBatchPrefs()).toMatchObject({
        aspect: '16:9', orientation: 'flip180', autoLens: true,
        nameMode: 'sequence', namePrefix: 'Event',
      })
      clearBatchPrefs()
      expect(loadBatchPrefs()).toEqual(DEFAULT_BATCH_PREFS)
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage
      vi.restoreAllMocks()
    }
  })
})
