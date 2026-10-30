import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BACKGROUND_TRANSFORM,
  normalizeBackgroundTransform,
  resolveBackgroundFill,
} from './backgroundReplace.ts'

describe('background transform', () => {
  it('defaults to the exact cover position', () => {
    expect(normalizeBackgroundTransform()).toEqual(DEFAULT_BACKGROUND_TRANSFORM)
    expect(normalizeBackgroundTransform({ scale: 0.5 })).toEqual(DEFAULT_BACKGROUND_TRANSFORM)
  })

  it('clamps scale and keeps movement inside the extra coverage', () => {
    const t = normalizeBackgroundTransform({ scale: 2, x: 1, y: -1, flip: true })
    expect(t.scale).toBe(1.8)
    expect(t.x).toBeCloseTo(0.4)
    expect(t.y).toBeCloseTo(-0.4)
    expect(t.flip).toBe(true)

    const clamped = normalizeBackgroundTransform({ scale: 1.4, x: 9, y: -9 })
    expect(clamped.x).toBeCloseTo(0.2)
    expect(clamped.y).toBeCloseTo(-0.2)
  })

  it('passes the transform to sky / image fills but not to solid colors', () => {
    const sky = resolveBackgroundFill(
      'sky-sunset', '#ffffff', null, { scale: 1.2, x: 1, y: 0, flip: true },
    )
    expect(sky).toMatchObject({
      kind: 'sky', preset: 'sunset',
      transform: { scale: 1.2, flip: true },
    })
    if (sky?.kind === 'sky') expect(sky.transform.x).toBeCloseTo(0.1)

    expect(resolveBackgroundFill('white', '#ffffff', null, { scale: 1.8 }))
      .toEqual({ kind: 'color', color: '#ffffff' })
  })
})
