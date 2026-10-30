// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PRESETS, type Preset } from '../core/presets'
import { ZERO } from '../../shared/adjustments.ts'
import {
  DEFAULT_STYLE_KEY, loadDefaultStyleId, normalizeDefaultStyleId,
  resolveDefaultStyle, saveDefaultStyleId,
} from './defaultStyle'

describe('默认风格偏好', () => {
  it('只接受内置 / 我的预设那套 id 形状', () => {
    expect(normalizeDefaultStyleId('portrait')).toBe('portrait')
    expect(normalizeDefaultStyleId(' 42 ')).toBe('42')
    expect(normalizeDefaultStyleId('')).toBeNull()
    expect(normalizeDefaultStyleId('   ')).toBeNull()
    expect(normalizeDefaultStyleId('a b')).toBeNull()
    expect(normalizeDefaultStyleId('x'.repeat(65))).toBeNull()
    expect(normalizeDefaultStyleId(null)).toBeNull()
    expect(normalizeDefaultStyleId(12)).toBeNull()
  })

  it('本机读写：null = 清掉；坏数据回 null', () => {
    localStorage.removeItem(DEFAULT_STYLE_KEY)
    expect(loadDefaultStyleId()).toBeNull()
    saveDefaultStyleId('film')
    expect(localStorage.getItem(DEFAULT_STYLE_KEY)).toBe('film')
    expect(loadDefaultStyleId()).toBe('film')
    saveDefaultStyleId(null)
    expect(localStorage.getItem(DEFAULT_STYLE_KEY)).toBeNull()
    localStorage.setItem(DEFAULT_STYLE_KEY, 'not a preset id')
    expect(loadDefaultStyleId()).toBeNull()
  })

  it('在「内置 + 我的预设」里找；找不到就回 null，不抛', () => {
    const mine: Preset = {
      id: '42',
      label: '我的夜色',
      adjustments: { ...ZERO, exposure: 12, temperature: -8 },
    }
    expect(resolveDefaultStyle('portrait', [mine])).toEqual(
      PRESETS.find(p => p.id === 'portrait'),
    )
    expect(resolveDefaultStyle('42', [mine])).toBe(mine)
    expect(resolveDefaultStyle('gone', [mine])).toBeNull()
    expect(resolveDefaultStyle(null, [mine])).toBeNull()
  })
})
