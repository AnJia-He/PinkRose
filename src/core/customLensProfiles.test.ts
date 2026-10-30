// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  customLensProfiles, deleteCustomLensProfile, MAX_CUSTOM_LENS_PROFILES,
  saveCustomLensProfile,
} from './customLensProfiles.ts'

const KEY = 'pinkrose.lensProfiles.v1'

beforeEach(() => localStorage.clear())

describe('自定义镜头配置', () => {
  it('保存时钳制数值、保留镜头型号，并能删掉', () => {
    const list = saveCustomLensProfile({
      name: '  我的 135  ', lensText: 'Mystery 135mm F2',
      distortion: 120, vignette: -140, chromatic: 7.6,
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      label: '我的 135', custom: true, maker: '我的配置',
      distortion: 100, vignette: -100, chromatic: 8,
      lensPatterns: ['Mystery 135mm F2'],
    })
    expect(customLensProfiles()).toHaveLength(1)
    expect(deleteCustomLensProfile(list[0]!.id)).toEqual([])
  })

  it('同名覆盖，最多保留 20 条', () => {
    saveCustomLensProfile({ name: '同一条', lensText: 'A', distortion: 1, vignette: 2, chromatic: 3 })
    saveCustomLensProfile({ name: '同一条', lensText: 'B', distortion: 4, vignette: 5, chromatic: 6 })
    expect(customLensProfiles()).toHaveLength(1)
    expect(customLensProfiles()[0]!.lensPatterns).toEqual(['B'])
    for (let i = 0; i < MAX_CUSTOM_LENS_PROFILES + 5; i++) {
      saveCustomLensProfile({
        name: `配置 ${i}`, lensText: `Lens ${i}`,
        distortion: i, vignette: 0, chromatic: 0,
      })
    }
    expect(customLensProfiles()).toHaveLength(MAX_CUSTOM_LENS_PROFILES)
  })

  it('坏数据不崩，返回空清单', () => {
    localStorage.setItem(KEY, '{not-json')
    expect(customLensProfiles()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify([{ id: 1 }, null, { name: '' }]))
    expect(customLensProfiles()).toEqual([])
  })
})
