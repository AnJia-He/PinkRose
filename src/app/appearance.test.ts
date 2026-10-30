// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_KEY, loadAppearance, normalizeAppearance, saveAppearance,
} from './appearance'

describe('界面外观偏好', () => {
  it('只接受 dark / light，坏值回深色', () => {
    expect(normalizeAppearance('light')).toBe('light')
    expect(normalizeAppearance('dark')).toBe('dark')
    expect(normalizeAppearance('system')).toBe('dark')
    expect(normalizeAppearance(null)).toBe('dark')
  })

  it('本机读写：写的是钳过的值；坏数据 / 空值回深色', () => {
    localStorage.removeItem(APPEARANCE_KEY)
    expect(loadAppearance()).toBe('dark')
    saveAppearance('light')
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe('light')
    expect(loadAppearance()).toBe('light')
    localStorage.setItem(APPEARANCE_KEY, 'nope')
    expect(loadAppearance()).toBe('dark')
  })
})
