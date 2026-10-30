import { describe, expect, it } from 'vitest'
import { dedupeRawPreviews } from './rawPair.ts'

const file = (name: string, path = name) => {
  const item = new File(['x'], name, { type: '' })
  Object.defineProperty(item, 'webkitRelativePath', { value: path })
  return item
}

describe('普通文件夹里的 RAW + 预览配对', () => {
  it('同目录同名的 JPG 与 RAW 只保留 RAW，并沿用靠前的位置', () => {
    const jpeg = file('IMG_0001.JPG', 'day/IMG_0001.JPG')
    const other = file('IMG_0002.JPG', 'day/IMG_0002.JPG')
    const raw = file('IMG_0001.CR3', 'day/IMG_0001.CR3')
    const result = dedupeRawPreviews([jpeg, other, raw])

    expect(result.files).toEqual([raw, other])
    expect(result.skippedPreviews).toEqual([jpeg])
    expect(result.pairs).toEqual([{ raw, preview: jpeg }])
  })

  it('Apple ProRAW 的 HEIC 预览也参与配对', () => {
    const heic = file('IMG_0100.HEIC', 'trip/IMG_0100.HEIC')
    const raw = file('IMG_0100.DNG', 'trip/IMG_0100.DNG')
    expect(dedupeRawPreviews([heic, raw]).files).toEqual([raw])
  })

  it('不同目录的同名文件、多个 RAW 或有歧义时都不猜', () => {
    const one = file('IMG_0001.JPG', 'day-1/IMG_0001.JPG')
    const two = file('IMG_0001.CR3', 'day-2/IMG_0001.CR3')
    expect(dedupeRawPreviews([one, two]).files).toEqual([one, two])

    const jpeg = file('IMG_0002.JPG', 'day/IMG_0002.JPG')
    const rawOne = file('IMG_0002.CR3', 'day/IMG_0002.CR3')
    const rawTwo = file('IMG_0002.NEF', 'day/IMG_0002.NEF')
    expect(dedupeRawPreviews([jpeg, rawOne, rawTwo]).files)
      .toEqual([jpeg, rawOne, rawTwo])
  })
})
