import { describe, expect, it, vi } from 'vitest'

const { makeCanvas, putImageData } = vi.hoisted(() => {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ])
  const putImageData = vi.fn()
  const makeCanvas = vi.fn((width: number, height: number) => {
    const canvas = {
      width,
      height,
      toBlob: (resolve: (blob: Blob | null) => void, type: string) =>
        resolve(new Blob([png], { type })),
    }
    return {
      canvas,
      ctx: {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray([255, 0, 0, 255]), width, height,
        })),
        putImageData,
      },
    }
  })
  return { makeCanvas, putImageData }
})

vi.mock('../core/canvas', () => ({ makeCanvas }))

import { buildExportBlob } from './save.ts'
import { detectSourceColorProfile } from '../image/sourceProfile.ts'

describe('Display P3 导出文件', () => {
  it('PNG 真的转换像素并嵌入 P3 ICC', async () => {
    const source = { width: 1, height: 1 } as HTMLCanvasElement
    const original = new File(['original'], 'photo.jpg', { type: 'image/jpeg' })

    const blob = await buildExportBlob(
      source, original, 'image/png', 0.92, true, 'display-p3',
    )
    const output = new File([await blob.arrayBuffer()], 'photo.png', { type: 'image/png' })

    expect(makeCanvas).toHaveBeenCalled()
    expect(putImageData).toHaveBeenCalled()
    expect(await detectSourceColorProfile(output)).toBe('display-p3')
  })
})
