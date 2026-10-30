import { describe, expect, it } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import {
  LENS_PROFILES, lensProfileAdjustments, lensProfileById, matchLensProfile,
} from './lensProfile.ts'
import type { LensInfo } from './photoInfo.ts'

const info = (patch: Partial<LensInfo>): LensInfo => ({
  make: null, model: null, lens: null, focalMm: null, focal35mm: null, hasExif: true,
  ...patch,
})

describe('matchLensProfile', () => {
  it('按镜头型号认 Sony / Canon / Nikon / Fujifilm', () => {
    expect(matchLensProfile(info({
      make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 24-70mm F2.8 GM II', focalMm: 50,
    }))?.profile.id).toBe('sony-fe-24-70-gm2')
    expect(matchLensProfile(info({
      make: 'Canon', model: 'EOS R5', lens: 'RF24-105mm F4 L IS USM', focalMm: 35,
    }))?.profile.id).toBe('canon-rf-24-105-f4l')
    expect(matchLensProfile(info({
      make: 'NIKON CORPORATION', model: 'Z 7II', lens: 'NIKKOR Z 50mm f/1.8 S', focalMm: 50,
    }))?.profile.id).toBe('nikon-z-50-18s')
    expect(matchLensProfile(info({
      make: 'FUJIFILM', model: 'X-T5', lens: 'XF18-55mmF2.8-4 R LM OIS', focalMm: 18,
    }))?.profile.id).toBe('fuji-xf-18-55')
  })

  it('镜头字段缺失时按机身认 iPhone 主摄', () => {
    const hit = matchLensProfile(info({
      make: 'Apple', model: 'iPhone 15 Pro', focalMm: 6.765,
    }))
    expect(hit?.profile.id).toBe('iphone-main')
    expect(hit?.matchedBy).toBe('camera')
  })

  it('认不出来的镜头返回 null，不硬套一套错参数', () => {
    expect(matchLensProfile(info({
      make: 'Unknown', model: 'Camera', lens: 'Mystery 135mm F2', focalMm: 135,
    }))).toBeNull()
  })

  it('用户自定义配置优先匹配同一支镜头', () => {
    const custom = {
      id: 'custom-1', maker: '我的配置', label: '我的 135',
      custom: true, lensPatterns: ['Mystery 135mm'],
      distortion: 12, vignette: 13, chromatic: 14,
    }
    const hit = matchLensProfile(info({
      make: 'Mystery', model: 'X', lens: 'Mystery 135mm F2',
    }), [custom])
    expect(hit?.profile.id).toBe('custom-1')
    expect(hit?.profile.distortion).toBe(12)
  })
})

describe('lensProfileAdjustments', () => {
  it('变焦按焦段在广角 / 长焦两端之间插值', () => {
    const profile = lensProfileById('sony-fe-16-35-gm')!
    expect(lensProfileAdjustments(profile, 16)).toMatchObject({
      lensDistortion: 42, lensVignette: 30, lensChromatic: 10,
    })
    expect(lensProfileAdjustments(profile, 35)).toMatchObject({
      lensDistortion: 26, lensVignette: 20, lensChromatic: 7,
    })
    const mid = lensProfileAdjustments(profile, 25.5)
    expect(mid.lensDistortion).toBe(34)
    expect(mid.lensDistortion).toBeLessThan(42)
    expect(mid.lensDistortion).toBeGreaterThan(26)
  })

  it('定焦就是那一组值，不随焦段乱动', () => {
    const profile = lensProfileById('canon-rf-50-18')!
    expect(lensProfileAdjustments(profile, 50)).toEqual({
      lensDistortion: 5, lensVignette: 26, lensChromatic: 4,
    })
    expect(lensProfileAdjustments(profile, null)).toEqual({
      lensDistortion: 5, lensVignette: 26, lensChromatic: 4,
    })
  })

  it('所有内置值都落在参数范围内，且不碰别的参数', () => {
    for (const profile of LENS_PROFILES) {
      const patch = lensProfileAdjustments(profile, profile.focalRange?.[0] ?? null)
      for (const value of Object.values(patch)) {
        expect(value).toBeGreaterThanOrEqual(-100)
        expect(value).toBeLessThanOrEqual(100)
      }
      const next = { ...ZERO, ...patch }
      expect(next.exposure).toBe(0)
      expect(next.skinSmooth).toBe(0)
    }
  })
})
