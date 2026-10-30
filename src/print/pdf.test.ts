import { describe, expect, it } from 'vitest'
import { jpegToPdf } from './pdf.ts'

describe('打印 PDF', () => {
  it('把 JPEG 包成 A4 单页 PDF，并写出正确的 xref 偏移', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3])
    const pdf = jpegToPdf(jpeg, 2480, 3508, 300)
    const text = Buffer.from(pdf).toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 595.2 841.92]')
    expect(text).toContain('/Width 2480 /Height 3508')
    expect(text).toContain('/Filter /DCTDecode')
    expect(text).toContain('/Length 7')
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)

    const xrefAt = text.indexOf('\nxref\n') + 1
    const entries = text.slice(xrefAt).split('\n').slice(3, 8)
    for (let i = 1; i <= 5; i++) {
      const offset = Number(entries[i - 1]!.slice(0, 10))
      expect(text.slice(offset, offset + 12)).toContain(`${i} 0 obj`)
    }
  })

  it('尺寸不合法直接报错', () => {
    expect(() => jpegToPdf(new Uint8Array([1]), 0, 100)).toThrow(/尺寸/)
    expect(() => jpegToPdf(new Uint8Array(), 100, 100)).toThrow(/尺寸/)
  })
})
