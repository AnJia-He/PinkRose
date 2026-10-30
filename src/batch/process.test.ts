// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import { saveCustomLensProfile } from '../core/customLensProfiles.ts'
import {
  batchBackgroundFill, batchDatedFilename, batchSequenceFilename,
  processBatchFiles, uniqueBatchFilename,
} from './process.ts'

const {
  decodeMock, buildExportBlobMock, disposeMock, renderMock, setLutMock, markExportCanvasMock,
  cropMock, sampleMock, setImageMock,
  selectSubjectMock, replaceBackgroundMock, transparentMock,
  detectFaceMock, detectFacesMock, faceMaskMock, smoothPortraitMock, blemishMock,
  faceLightMock, skinToneMock,
  smartCropDetectMock,
  upscaleTargetMock, upscaleToBitmapMock,
  duotonePixelsMock,
  faceShapeMock,
  readLensMock,
} = vi.hoisted(() => ({
  decodeMock: vi.fn(),
  buildExportBlobMock: vi.fn(),
  disposeMock: vi.fn(),
  renderMock: vi.fn(),
  setLutMock: vi.fn(),
  markExportCanvasMock: vi.fn(),
  cropMock: vi.fn(),
  sampleMock: vi.fn(),
  setImageMock: vi.fn(),
  selectSubjectMock: vi.fn(),
  replaceBackgroundMock: vi.fn(),
  transparentMock: vi.fn(),
  detectFaceMock: vi.fn(),
  detectFacesMock: vi.fn(),
  faceMaskMock: vi.fn(),
  smoothPortraitMock: vi.fn(),
  blemishMock: vi.fn(),
  faceLightMock: vi.fn(),
  skinToneMock: vi.fn(),
  smartCropDetectMock: vi.fn(),
  upscaleTargetMock: vi.fn(),
  upscaleToBitmapMock: vi.fn(),
  duotonePixelsMock: vi.fn(),
  faceShapeMock: vi.fn(),
  readLensMock: vi.fn(),
}))

vi.mock('../image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/decode')>()
  return { ...actual, decodeImageFile: decodeMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return {
    ...actual,
    buildExportBlob: buildExportBlobMock,
    markExportCanvas: markExportCanvasMock,
  }
})
vi.mock('../core/photoInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/photoInfo.ts')>()
  return { ...actual, readLensInfo: readLensMock }
})
vi.mock('../render/pipeline', () => ({
  TonePipeline: class {
    setImage = setImageMock
    resizeToImage = vi.fn()
    setLut = setLutMock
    render = renderMock
    dispose = disposeMock
  },
}))
vi.mock('../image/crop', () => ({ cropToBitmap: cropMock }))
vi.mock('../image/sample', () => ({ samplePixels: sampleMock }))
vi.mock('../image/backgroundSelect', () => ({ selectSubjectToMask: selectSubjectMock }))
vi.mock('../image/backgroundReplace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/backgroundReplace')>()
  return { ...actual, replaceBackgroundToBitmap: replaceBackgroundMock }
})
vi.mock('../image/transparency', () => ({ transparentToBitmap: transparentMock }))
vi.mock('../image/faceDetect', () => ({
  detectFaceInBitmap: detectFaceMock,
  detectFacesInBitmap: detectFacesMock,
}))
vi.mock('../image/faceMask', () => ({ faceMask: faceMaskMock }))
vi.mock('../image/smooth', () => ({
  smoothToBitmap: smoothPortraitMock,
  DEFAULT_SMOOTH_TEXTURE: 35,
}))
vi.mock('../image/blemish', () => ({ blemishToBitmap: blemishMock }))
vi.mock('../image/faceLight', () => ({ faceLightToBitmap: faceLightMock }))
vi.mock('../image/skinTone', () => ({ skinToneToBitmap: skinToneMock }))
vi.mock('../image/faceShape', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/faceShape')>()
  return { ...actual, faceShapeToBitmap: faceShapeMock }
})
vi.mock('../image/smartCrop', () => ({ detectSubjectBox: smartCropDetectMock }))
vi.mock('../image/upscale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/upscale')>()
  return {
    ...actual,
    upscaleTarget: upscaleTargetMock,
    upscaleToBitmap: upscaleToBitmapMock,
  }
})
vi.mock('../image/duotone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/duotone')>()
  return { ...actual, duotonePixels: duotonePixelsMock }
})
function fakeDecoded(tag: string) {
  const bitmap = {
    close: vi.fn(), __tag: tag, width: 1200, height: 800,
  } as unknown as ImageBitmap
  return { bitmap, width: 1200, height: 800 }
}

function fakeReplaced(tag: string, width = 1000, height = 700) {
  return {
    bitmap: {
      close: vi.fn(), __tag: tag, width, height,
    } as unknown as ImageBitmap,
    covered: 100,
  }
}

function fakeBlob(text: string, type = 'image/jpeg'): Blob {
  const blob = new Blob([text], { type })
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  })
  return blob
}

function fakeSidecar(text: string, name = 'shot.xmp'): File {
  const file = new File([text], name, { type: 'application/rdf+xml' })
  Object.defineProperty(file, 'text', { value: async () => text })
  return file
}

describe('batch processing', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    buildExportBlobMock.mockResolvedValue(fakeBlob('jpeg'))
    markExportCanvasMock.mockImplementation((canvas: HTMLCanvasElement) => canvas)
    selectSubjectMock.mockResolvedValue({ subjectRatio: 0.4, threshold: 0.5, covered: 100 })
    replaceBackgroundMock.mockResolvedValue(fakeReplaced('background'))
    transparentMock.mockResolvedValue(fakeReplaced('transparent'))
    detectFaceMock.mockResolvedValue({
      x: 100, y: 100, w: 200, h: 250, confidence: 0.9,
    })
    faceMaskMock.mockReturnValue(new Uint8Array(1))
    smoothPortraitMock.mockResolvedValue({
      bitmap: fakeReplaced('portrait-smooth').bitmap,
      covered: 100,
    })
    blemishMock.mockResolvedValue({
      bitmap: fakeReplaced('portrait-blemish').bitmap,
      spots: 1, healed: 10, usedSource: true,
    })
    faceLightMock.mockResolvedValue({
      bitmap: fakeReplaced('portrait-light').bitmap,
      changed: 100, scale: 1,
      face: { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 },
    })
    skinToneMock.mockResolvedValue({
      bitmap: fakeReplaced('portrait-tone').bitmap,
      changed: 100, scale: 1,
      face: { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 },
    })
    faceShapeMock.mockResolvedValue({
      bitmap: fakeReplaced('batch-shaped').bitmap,
      changed: 100, scale: 1,
      face: { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 },
    })
    readLensMock.mockResolvedValue({
      make: null, model: null, lens: null,
      focalMm: null, focal35mm: null, hasExif: false, takenAt: null,
    })
    smartCropDetectMock.mockResolvedValue({
      x0: 0.5, y0: 0.3, x1: 0.6, y1: 0.6, count: 100, ratio: 0.1,
    })
    upscaleTargetMock.mockReturnValue({ width: 2400, height: 1600 })
    upscaleToBitmapMock.mockResolvedValue(fakeReplaced('upscaled', 2400, 1600).bitmap)
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn((kind: string) => (
        kind === 'webgl2' ? null : {
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(Math.max(1, width * height * 4)),
          }),
          putImageData: vi.fn(),
        }
      )),
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
      configurable: true,
      value: vi.fn(() => 'data:image/jpeg;base64,thumb'),
    })
  })

  it('uses _2 / _3 suffixes for duplicate output names', () => {
    const used = new Set<string>()
    expect(uniqueBatchFilename('same_pinkrose.jpg', used)).toBe('same_pinkrose.jpg')
    expect(uniqueBatchFilename('same_pinkrose.jpg', used)).toBe('same_pinkrose_2.jpg')
    expect(uniqueBatchFilename('same_pinkrose.jpg', used)).toBe('same_pinkrose_3.jpg')
  })

  it('前缀 + 序号：清理非法文件名字符，序号固定三位', () => {
    expect(batchSequenceFilename('  Summer:/2026  ', 1, 'image/jpeg'))
      .toBe('Summer2026-001.jpg')
    expect(batchSequenceFilename('', 2, 'image/png')).toBe('PinkRose-002.png')
    expect(batchSequenceFilename('Trip', 12, 'image/webp')).toBe('Trip-012.webp')
    expect(batchSequenceFilename('Print', 3, 'image/tiff')).toBe('Print-003.tif')
  })

  it('★ 批量背景选项：纯色 / 证件蓝 / 虚化 / 透明分别翻成像素层参数', () => {
    expect(batchBackgroundFill({ kind: 'white' })).toEqual({ kind: 'color', color: '#ffffff' })
    expect(batchBackgroundFill({ kind: 'blue' })).toEqual({ kind: 'color', color: '#438edb' })
    expect(batchBackgroundFill({ kind: 'blur' })).toEqual({ kind: 'blur' })
    expect(batchBackgroundFill({ kind: 'transparent' })).toBeNull()
    expect(batchBackgroundFill({ kind: 'off' })).toBeNull()
    const bitmap = { width: 80, height: 60 } as unknown as ImageBitmap
    expect(batchBackgroundFill({ kind: 'image', bitmap })).toMatchObject({
      kind: 'image', bitmap,
    })
    expect(batchBackgroundFill({ kind: 'image' })).toBeNull()
  })

  it('continues after one bad file and still builds a ZIP', async () => {
    const first = fakeDecoded('first')
    const third = fakeDecoded('third')
    decodeMock
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('这张图打不开'))
      .mockResolvedValueOnce(third)
    const progress: number[] = []
    const inputs = ['a.jpg', 'bad.jpg', 'a.jpg'].map((name, i) => ({
      id: String(i),
      file: new File(['x'], name, { type: 'image/jpeg' }),
    }))

    const outcome = await processBatchFiles(
      inputs,
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      p => progress.push(p.completed),
    )

    expect(outcome.successes).toHaveLength(2)
    expect(outcome.successes[0]!.blob).toBeInstanceOf(Blob)
    expect(outcome.successes[0]!.preview).toMatch(/^data:image\/jpeg;base64,/)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]!.message).toBe('这张图打不开，换一张试试')
    expect(outcome.archive).not.toBeNull()
    expect(decodeMock).toHaveBeenCalledTimes(3)
    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(first.bitmap.close).toHaveBeenCalledTimes(1)
    expect(third.bitmap.close).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toBe(3)
  })

  it('★ RAW 内嵌预览在批量结果里单独计数，不静默当完整解档', async () => {
    const preview = {
      ...fakeDecoded('raw-preview'),
      rawPreview: { width: 1600, height: 1067 },
    }
    decodeMock.mockResolvedValueOnce(preview)
    const outcome = await processBatchFiles(
      [{ id: 'raw', file: new File(['raw'], 'shot.DNG', { type: 'image/x-adobe-dng' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
    )
    expect(outcome.rawPreviewCount).toBe(1)
    expect(outcome.successes[0]?.rawPreview).toEqual({ width: 1600, height: 1067 })
  })

  it('★ 批量自动镜头校正：内置 + 自定义认出的按 EXIF 覆盖三根，认不出的保留', async () => {
    saveCustomLensProfile({
      name: '我的 135', lensText: 'Unknown 135mm',
      distortion: 12, vignette: 13, chromatic: 14,
    })
    decodeMock.mockImplementation(async (file: File) => fakeDecoded(file.name))
    readLensMock.mockImplementation(async (file: File) => file.name.startsWith('sony')
      ? {
        make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 85mm F1.8',
        focalMm: 85, focal35mm: 85, hasExif: true,
      }
      : file.name.startsWith('unknown')
        ? {
          make: 'Mystery', model: 'X', lens: 'Unknown 135mm',
          focalMm: 135, focal35mm: 135, hasExif: true,
        }
        : {
          make: 'Other', model: 'Y', lens: 'Other 200mm',
          focalMm: 200, focal35mm: 200, hasExif: true,
        })
    const inputs = ['sony.jpg', 'unknown.jpg', 'other.jpg'].map((name, i) => ({
      id: String(i), file: new File(['x'], name, { type: 'image/jpeg' }),
    }))
    const outcome = await processBatchFiles(
      inputs,
      ZERO,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { autoLens: true },
    )
    expect(outcome.lensMatched).toBe(2)
    expect(outcome.lensSkipped).toBe(1)
    expect(renderMock.mock.calls[0]![0]).toMatchObject({
      lensDistortion: 6, lensVignette: 24, lensChromatic: 5,
    })
    expect(renderMock.mock.calls[1]![0]).toMatchObject({
      lensDistortion: 12, lensVignette: 13, lensChromatic: 14,
    })
    expect(renderMock.mock.calls[2]![0]).toMatchObject({
      lensDistortion: 0, lensVignette: 0, lensChromatic: 0,
    })
  })

  it('HEIC 解码失败时给出转成 JPG 的可执行提示', async () => {
    decodeMock.mockRejectedValueOnce(new Error('cannot decode'))
    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
    )
    expect(outcome.failures[0]!.message).toContain('Safari')
    expect(outcome.failures[0]!.message).toContain('导出成 JPG')
  })

  it('stops before the next file when aborted', async () => {
    const first = fakeDecoded('first')
    decodeMock.mockResolvedValueOnce(first)
    const controller = new AbortController()
    buildExportBlobMock.mockImplementationOnce(async () => {
      controller.abort()
      return fakeBlob('jpeg')
    })

    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'b.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      controller.signal,
    )

    expect(outcome.cancelled).toBe(true)
    expect(outcome.successes).toHaveLength(0)
    expect(outcome.archive).toBeNull()
    expect(decodeMock).toHaveBeenCalledTimes(1)
  })

  it('传了水印就逐张画在导出画布上', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('one'))
    const watermark = {
      text: 'PinkRose', position: 'bottom-right' as const,
      opacity: 70, sizePct: 4, color: '#ffffff',
    }
    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      watermark,
    )
    expect(markExportCanvasMock).toHaveBeenCalledTimes(1)
    expect(markExportCanvasMock.mock.calls[0]![1]).toEqual(watermark)
    expect(markExportCanvasMock.mock.calls[0]![2]).toBeUndefined()
  })

  it('Logo 水印把图片源一起交给引擎', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('logo-one'))
    const watermark = {
      text: '', position: 'bottom-right' as const,
      opacity: 70, sizePct: 4, color: '#ffffff',
      kind: 'logo' as const, tile: true, logoSizePct: 18,
    }
    const logo = {
      source: { __tag: 'logo' } as unknown as CanvasImageSource,
      width: 120,
      height: 60,
      name: 'mark.png',
    }
    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      watermark,
      logo,
    )
    expect(markExportCanvasMock.mock.calls[0]![1]).toEqual(watermark)
    expect(markExportCanvasMock.mock.calls[0]![2]).toBe(logo)
  })

  it('批量可叠加 Lut 与强度，预设参数仍原样传入', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('lut'))
    const cube = {
      size: 2, rgba: new Uint8Array(2 * 2 * 2 * 4),
      domainMin: [0, 0, 0] as [number, number, number],
      domainMax: [1, 1, 1] as [number, number, number],
      title: 'batch',
    }
    const adjustments = { exposure: 10 } as never
    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }],
      adjustments,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      undefined,
      undefined,
      { lut: { cube, amount: 37 } },
    )
    expect(setLutMock).toHaveBeenCalledWith(cube)
    expect(renderMock).toHaveBeenCalledWith(adjustments, 37)
  })

  it('★ 批量双色调：整批共用一个渐变，在导出前套到合成结果上', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('tone'))
    const duotone = {
      preset: 'violet' as const,
      shadow: '#160b2e',
      highlight: '#f0c8ff',
      intensity: 80,
    }
    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { duotone },
    )
    expect(duotonePixelsMock).toHaveBeenCalledTimes(1)
    const [, width, height, options] = duotonePixelsMock.mock.calls[0]!
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(options).toMatchObject(duotone)
    expect(outcome.successes).toHaveLength(1)
  })

  it('整批统一方向：先转再按新尺寸进入后续画幅 / 导出', async () => {
    const source = fakeDecoded('turned-source')
    const turned = {
      bitmap: {
        close: vi.fn(), __tag: 'turned', width: 800, height: 1200,
      } as unknown as ImageBitmap,
      width: 800,
      height: 1200,
    }
    decodeMock.mockResolvedValueOnce(source)
    cropMock.mockResolvedValueOnce(turned.bitmap)
    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { rotateTurns: 1, flipH: true },
    )
    expect(cropMock).toHaveBeenCalledWith(source.bitmap, {
      rect: { x: 0, y: 0, w: 1, h: 1 },
      angle: 0,
      flipH: true,
      flipV: false,
    }, 1)
    expect(source.bitmap.close).toHaveBeenCalledTimes(1)
    expect(outcome.successes[0]).toMatchObject({ width: 800, height: 1200 })
  })

  it('统一画幅：居中裁成方形后再进入管线', async () => {
    const source = fakeDecoded('wide')
    const cropped = {
      bitmap: {
        close: vi.fn(), __tag: 'square', width: 800, height: 800,
      } as unknown as ImageBitmap,
      width: 800,
      height: 800,
    }
    decodeMock.mockResolvedValueOnce(source)
    cropMock.mockResolvedValueOnce(cropped.bitmap)
    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'wide.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { aspect: '1:1' },
    )
    expect(cropMock).toHaveBeenCalledTimes(1)
    expect(cropMock.mock.calls[0]![1]).toEqual({
      rect: { x: 1 / 6, y: 0, w: 2 / 3, h: 1 },
      angle: 0,
    })
    expect(source.bitmap.close).toHaveBeenCalledTimes(1)
    expect(outcome.successes[0]).toMatchObject({ width: 800, height: 800 })
  })

  it('自动增强：逐张按样本校正，同时保留预设的其它参数', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('dark'))
    sampleMock.mockReturnValueOnce([[40, 40, 40]])
    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'dark.jpg', { type: 'image/jpeg' }) }],
      { vignette: 30, clarity: 20 } as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { autoEnhance: true },
    )
    expect(sampleMock).toHaveBeenCalledTimes(1)
    const params = renderMock.mock.calls[0]![0] as {
      exposure: number; vignette: number; clarity: number
    }
    expect(params.exposure).toBeGreaterThan(20)
    expect(params.vignette).toBe(30)
    expect(params.clarity).toBe(20)
  })

  it('按前缀 + 序号重命名整批输出', async () => {
    decodeMock
      .mockResolvedValueOnce(fakeDecoded('one'))
      .mockResolvedValueOnce(fakeDecoded('two'))
    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'first.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'second.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/png', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { rename: { mode: 'sequence', prefix: 'Trip' } },
    )
    expect(outcome.successes.map(s => s.filename)).toEqual([
      'Trip-001.png', 'Trip-002.png',
    ])
  })

  it('命名日期优先用 EXIF，缺失时回退文件修改日期并报告张数', () => {
    const fallback = new Date(2025, 0, 2, 12, 0, 0).getTime()
    expect(batchDatedFilename('Trip', '2026-10-21 14:30', fallback, 2, 'image/jpeg'))
      .toBe('Trip-20261021-002.jpg')
    expect(batchDatedFilename('Trip', null, fallback, 3, 'image/png'))
      .toBe('Trip-20250102-003.png')
  })

  it('按拍摄日期 + 序号重命名整批输出', async () => {
    decodeMock
      .mockResolvedValueOnce(fakeDecoded('one'))
      .mockResolvedValueOnce(fakeDecoded('two'))
    readLensMock
      .mockResolvedValueOnce({
        make: 'SONY', model: 'ILCE-7CM2', lens: 'FE 50mm F1.4 GM',
        focalMm: null, focal35mm: null, hasExif: true,
        takenAt: '2026-10-20 08:15',
        takenAtMs: new Date(2026, 9, 20, 8, 15, 30).getTime(),
      })
      .mockResolvedValueOnce({
        make: null, model: null, lens: null,
        focalMm: null, focal35mm: null, hasExif: false, takenAt: null,
      })
    const fallback = new Date(2025, 0, 2, 12, 0, 0).getTime()
    const second = new File(['x'], 'second.jpg', {
      type: 'image/jpeg', lastModified: fallback,
    })
    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'first.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: second },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { rename: { mode: 'date', prefix: 'Trip' } },
    )
    expect(outcome.successes.map(success => success.filename)).toEqual([
      'Trip-20261020-001.jpg', 'Trip-20250102-002.jpg',
    ])
    expect(outcome.successes[0]?.capturedAt)
      .toBe(new Date(2026, 9, 20, 8, 15, 30).getTime())
    expect(outcome.successes[0]).toMatchObject({
      cameraMake: 'SONY', cameraModel: 'ILCE-7CM2', lensModel: 'FE 50mm F1.4 GM',
    })
    expect(outcome.successes[1]?.capturedAt).toBeUndefined()
    expect(outcome.dateFallbackCount).toBe(1)
  })

  it('★ 批量透明背景：逐张识别主体、换底图，并自动改用 PNG', async () => {
    const source = fakeDecoded('source')
    const cutout = fakeReplaced('cutout')
    decodeMock.mockResolvedValueOnce(source)
    transparentMock.mockResolvedValueOnce(cutout)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'portrait.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { background: { kind: 'transparent' } },
    )

    expect(selectSubjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'source' }),
      expect.any(Uint8Array),
    )
    expect(transparentMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.any(Uint8Array),
    )
    expect(replaceBackgroundMock).not.toHaveBeenCalled()
    expect(setImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ bitmap: expect.objectContaining({ __tag: 'source' }) }),
    )
    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/png')
    expect(outcome.successes[0]).toMatchObject({
      filename: 'portrait_pinkrose.png',
      width: 1200,
      height: 800,
    })
    expect(source.bitmap.close).toHaveBeenCalledTimes(1)
    expect(cutout.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('★ 批量透明背景选择 TIFF 时保留 TIFF，并继续生成 JPEG 作品母版', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('source'))
    transparentMock.mockResolvedValueOnce(fakeReplaced('cutout'))
    buildExportBlobMock
      .mockResolvedValueOnce(fakeBlob('tiff', 'image/tiff'))
      .mockResolvedValueOnce(fakeBlob('jpeg', 'image/jpeg'))

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'portrait.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/tiff', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { background: { kind: 'transparent' } },
    )

    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/tiff')
    expect(buildExportBlobMock.mock.calls[1]![2]).toBe('image/jpeg')
    expect(outcome.successes[0]).toMatchObject({
      filename: 'portrait_pinkrose.tif',
    })
    expect(outcome.successes[0]!.blob?.type).toBe('image/tiff')
    expect(outcome.successes[0]!.workBlob?.type).toBe('image/jpeg')
  })

  it('★ 批量纯色背景：颜色和用户画幅一起交给换背景引擎，格式仍用用户选择', async () => {
    const source = fakeDecoded('color-source')
    const filled = fakeReplaced('filled')
    decodeMock.mockResolvedValueOnce(source)
    replaceBackgroundMock.mockResolvedValueOnce(filled)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'product.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/webp', qualityPct: 88, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { background: { kind: 'color', color: '#123456' } },
    )

    expect(replaceBackgroundMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.any(Uint8Array),
      { kind: 'color', color: '#123456' },
    )
    expect(transparentMock).not.toHaveBeenCalled()
    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/webp')
    expect(buildExportBlobMock.mock.calls[0]![3]).toBeCloseTo(0.88)
    expect(outcome.successes[0]!.filename).toBe('product_pinkrose.webp')
  })

  it('批量 Display P3：成片按 P3 编码，作品集 JPEG 母版仍保持 sRGB', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('p3-source'))
    buildExportBlobMock.mockImplementation(async (
      _canvas: HTMLCanvasElement,
      _file: File,
      format: string,
    ) => fakeBlob(format, format))

    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'product.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/webp', qualityPct: 90, longEdge: null, colorSpace: 'display-p3' },
      () => {},
    )

    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/webp')
    expect(buildExportBlobMock.mock.calls[0]![5]).toBe('display-p3')
    expect(buildExportBlobMock.mock.calls[1]![2]).toBe('image/jpeg')
    expect(buildExportBlobMock.mock.calls[1]![5]).toBe('srgb')
  })

  it('★ 批量关闭拍摄信息后，成片和作品母版都不再写回 EXIF', async () => {
    decodeMock.mockResolvedValueOnce(fakeDecoded('private-source'))
    buildExportBlobMock.mockImplementation(async (
      _canvas: HTMLCanvasElement,
      _file: File,
      format: string,
    ) => fakeBlob(format, format))

    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'private.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      {
        format: 'image/webp',
        qualityPct: 88,
        longEdge: null,
        preserveMetadata: false,
        preserveLocation: false,
      },
      () => {},
    )

    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/webp')
    expect(buildExportBlobMock.mock.calls[0]![4]).toBe(false)
    expect(buildExportBlobMock.mock.calls[0]![6]).toBe(false)
    expect(buildExportBlobMock.mock.calls[1]![2]).toBe('image/jpeg')
    expect(buildExportBlobMock.mock.calls[1]![4]).toBe(false)
    expect(buildExportBlobMock.mock.calls[1]![6]).toBe(false)
  })

  it('★ WebP / AVIF / HEIC 批量成片另存一份 JPEG 母版给作品集', async () => {
    const source = fakeDecoded('work-copy-source')
    decodeMock.mockResolvedValueOnce(source)
    buildExportBlobMock.mockImplementation(async (
      _canvas: HTMLCanvasElement,
      _file: File,
      format: string,
    ) => fakeBlob(format, format))

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'product.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/webp', qualityPct: 88, longEdge: null },
      () => {},
    )

    expect(buildExportBlobMock).toHaveBeenCalledTimes(2)
    expect(buildExportBlobMock.mock.calls[0]![2]).toBe('image/webp')
    expect(buildExportBlobMock.mock.calls[1]![2]).toBe('image/jpeg')
    expect(outcome.successes[0]!.blob?.type).toBe('image/webp')
    expect(outcome.successes[0]!.workBlob?.type).toBe('image/jpeg')
  })

  it('★ 批量自定义背景图：整批复用同一张位图，不替调用方关闭', async () => {
    const source = fakeDecoded('image-bg-source')
    const filled = fakeReplaced('image-bg-filled')
    const background = {
      close: vi.fn(), width: 900, height: 600, __tag: 'batch-background',
    } as unknown as ImageBitmap
    decodeMock.mockResolvedValueOnce(source)
    replaceBackgroundMock.mockResolvedValueOnce(filled)

    await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'portrait.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/png', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { background: { kind: 'image', bitmap: background, name: 'studio.png' } },
    )

    expect(replaceBackgroundMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.any(Uint8Array),
      expect.objectContaining({ kind: 'image', bitmap: background }),
    )
    expect(background.close).not.toHaveBeenCalled()
  })

  it('★ 没认出主体只跳过那一张，整批继续', async () => {
    const first = fakeDecoded('no-subject')
    const second = fakeDecoded('subject')
    const cutout = fakeReplaced('cutout')
    decodeMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    selectSubjectMock
      .mockResolvedValueOnce({ subjectRatio: 0.01, threshold: 0.5, covered: 0 })
      .mockResolvedValueOnce({ subjectRatio: 0.4, threshold: 0.5, covered: 100 })
    transparentMock.mockResolvedValueOnce(cutout)

    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'blank.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'person.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { background: { kind: 'transparent' } },
    )

    expect(outcome.successes).toHaveLength(1)
    expect(outcome.successes[0]!.sourceName).toBe('person.jpg')
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]!.message).toContain('没认出主体')
    expect(transparentMock).toHaveBeenCalledTimes(1)
    expect(first.bitmap.close).toHaveBeenCalledTimes(1)
    expect(second.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('★ 换背景回来时已经按了停止：不记成功、不继续下一张', async () => {
    const source = fakeDecoded('abort-source')
    const cutout = fakeReplaced('abort-cutout')
    const controller = new AbortController()
    decodeMock.mockResolvedValueOnce(source)
    transparentMock.mockImplementationOnce(async () => {
      controller.abort()
      return cutout
    })

    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'b.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      controller.signal,
      null,
      null,
      { background: { kind: 'transparent' } },
    )

    expect(outcome.cancelled).toBe(true)
    expect(outcome.successes).toHaveLength(0)
    expect(outcome.archive).toBeNull()
    expect(decodeMock).toHaveBeenCalledTimes(1)
    expect(cutout.bitmap.close).toHaveBeenCalledTimes(1)
    expect(source.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('★ 批量人像：有脸的精修、没脸的保留原样并计数', async () => {
    const first = fakeDecoded('portrait-source')
    const second = fakeDecoded('landscape-source')
    const smoothed = fakeReplaced('portrait-smoothed')
    const lit = fakeReplaced('portrait-lit')
    const toned = fakeReplaced('portrait-tone')
    const face = { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 }
    decodeMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    detectFaceMock.mockResolvedValueOnce(face).mockResolvedValueOnce(null)
    smoothPortraitMock.mockResolvedValueOnce({ bitmap: smoothed.bitmap, covered: 100 })
    faceLightMock.mockResolvedValueOnce({
      bitmap: lit.bitmap, changed: 100, scale: 1, face,
    })
    skinToneMock.mockResolvedValueOnce({
      bitmap: toned.bitmap, changed: 100, scale: 1, face,
    })

    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'person.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'landscape.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { portrait: { smooth: 30, light: 20, whiten: 18, rosy: 12 } },
    )

    expect(detectFaceMock).toHaveBeenCalledTimes(2)
    expect(faceMaskMock).toHaveBeenCalledWith(1200, 800, face)
    expect(smoothPortraitMock).toHaveBeenCalledTimes(1)
    expect(faceLightMock).toHaveBeenCalledTimes(1)
    expect(skinToneMock).toHaveBeenCalledWith(
      lit.bitmap, face, { whiten: 18, rosy: 12 },
    )
    expect(outcome.successes).toHaveLength(2)
    expect(outcome.portraitSkipped).toBe(1)
    expect(setImageMock.mock.calls[0]![0]).toMatchObject({
      bitmap: { __tag: 'portrait-tone' },
    })
    expect(setImageMock.mock.calls[1]![0]).toMatchObject({
      bitmap: { __tag: 'landscape-source' },
    })
    expect(first.bitmap.close).toHaveBeenCalledTimes(1)
    expect(smoothed.bitmap.close).toHaveBeenCalledTimes(1)
    expect(lit.bitmap.close).toHaveBeenCalledTimes(1)
    expect(toned.bitmap.close).toHaveBeenCalledTimes(1)
    expect(second.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('★ 批量人像塑形：瘦脸 / 瘦颈 / 双下巴在磨皮之前套用', async () => {
    const source = fakeDecoded('shape-source')
    const shaped = fakeReplaced('shaped')
    decodeMock.mockResolvedValueOnce(source)
    faceShapeMock.mockResolvedValueOnce({
      bitmap: shaped.bitmap,
      changed: 100, scale: 1,
      face: { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 },
    })

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'face.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      {
        portrait: {
          slim: 20, neck: 30, doubleChin: 40, shoulder: 50, smile: 15, smooth: 10,
        },
      },
    )

    expect(faceShapeMock).toHaveBeenCalledWith(
      source.bitmap,
      expect.objectContaining({ x: 100, y: 100 }),
      { slim: 20, neck: 30, doubleChin: 40, shoulder: 50, smile: 15 },
    )
    expect(smoothPortraitMock).toHaveBeenCalledWith(
      shaped.bitmap,
      expect.any(Uint8Array),
      { strength: 10, texture: 35 },
    )
    expect(outcome.successes).toHaveLength(1)
    expect(outcome.portraitSkipped).toBe(0)
  })

  it('★ 合影多人脸：走多脸检测、合并蒙版一次磨皮，并统计覆盖脸数', async () => {
    const source = fakeDecoded('group-source')
    decodeMock.mockResolvedValueOnce(source)
    detectFacesMock.mockResolvedValueOnce([
      { x: 100, y: 100, w: 200, h: 250, confidence: 0.9 },
      { x: 500, y: 110, w: 190, h: 240, confidence: 0.86 },
    ])

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'group.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { portrait: { multiFace: true, smooth: 55 } },
    )

    expect(detectFaceMock).not.toHaveBeenCalled()
    expect(detectFacesMock).toHaveBeenCalledWith(source.bitmap, 6)
    expect(faceMaskMock).toHaveBeenCalledTimes(2)
    expect(smoothPortraitMock).toHaveBeenCalledTimes(1)
    expect(outcome.portraitFaces).toBe(2)
    expect(outcome.successes).toHaveLength(1)
  })

  it('★ 批量去斑：没找到斑点时保留原图，不把空结果写进去', async () => {
    const source = fakeDecoded('blemish-source')
    const empty = fakeReplaced('empty-blemish')
    decodeMock.mockResolvedValueOnce(source)
    blemishMock.mockResolvedValueOnce({
      bitmap: empty.bitmap, spots: 0, healed: 0, usedSource: false,
    })

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'face.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { portrait: { blemish: true } },
    )

    expect(blemishMock).toHaveBeenCalledTimes(1)
    expect(empty.bitmap.close).toHaveBeenCalledTimes(1)
    expect(setImageMock.mock.calls[0]![0]).toMatchObject({
      bitmap: { __tag: 'blemish-source' },
    })
    expect(outcome.portraitSkipped).toBe(0)
  })

  it('★ 人像精修失败只跳过该张，整批继续', async () => {
    const first = fakeDecoded('face-error')
    const second = fakeDecoded('after-error')
    decodeMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    detectFaceMock.mockRejectedValueOnce(new Error('face engine broke'))

    const outcome = await processBatchFiles(
      [
        { id: '1', file: new File(['x'], 'broken.jpg', { type: 'image/jpeg' }) },
        { id: '2', file: new File(['x'], 'ok.jpg', { type: 'image/jpeg' }) },
      ],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { portrait: { smooth: 30 } },
    )

    expect(outcome.successes).toHaveLength(1)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]!.message).toContain('人像精修没做成')
    expect(outcome.portraitSkipped).toBe(0)
  })

  it('★ 批量智能构图：按主体中心移动统一画幅的裁切框', async () => {
    const source = fakeDecoded('smart-wide')
    const cropped = {
      bitmap: {
        close: vi.fn(), __tag: 'smart-square', width: 800, height: 800,
      } as unknown as ImageBitmap,
      width: 800,
      height: 800,
    }
    decodeMock.mockResolvedValueOnce(source)
    cropMock.mockResolvedValueOnce(cropped.bitmap)
    smartCropDetectMock.mockResolvedValueOnce({
      x0: 0.5, y0: 0.3, x1: 0.6, y1: 0.6, count: 100, ratio: 0.1,
    })

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'wide.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { aspect: '1:1', smartCrop: true },
    )

    expect(smartCropDetectMock).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'smart-wide' }),
    )
    const rect = cropMock.mock.calls[0]![1].rect
    // 主体中心 x=0.55 → 660px；800 方框左边 = 260px。
    expect(rect.x).toBeCloseTo(260 / 1200, 8)
    expect(rect.y).toBe(0)
    expect(rect.w).toBeCloseTo(800 / 1200, 8)
    expect(rect.h).toBe(1)
    expect(outcome.smartCropFallbacks).toBe(0)
  })

  it('★ 批量智能构图认不出主体：退回居中，并单独计数', async () => {
    const source = fakeDecoded('no-subject-crop')
    const cropped = {
      bitmap: {
        close: vi.fn(), __tag: 'center-square', width: 800, height: 800,
      } as unknown as ImageBitmap,
      width: 800,
      height: 800,
    }
    decodeMock.mockResolvedValueOnce(source)
    cropMock.mockResolvedValueOnce(cropped.bitmap)
    smartCropDetectMock.mockResolvedValueOnce(null)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'wide.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { aspect: '1:1', smartCrop: true },
    )

    const rect = cropMock.mock.calls[0]![1].rect
    expect(rect).toEqual({ x: 1 / 6, y: 0, w: 2 / 3, h: 1 })
    expect(outcome.smartCropFallbacks).toBe(1)
  })

  it('★ 逐张手动取景优先：不再跑主体检测，按用户框裁', async () => {
    const source = fakeDecoded('manual-frame')
    const cropped = {
      bitmap: {
        close: vi.fn(), __tag: 'manual-crop', width: 300, height: 400,
      } as unknown as ImageBitmap,
      width: 300,
      height: 400,
    }
    decodeMock.mockResolvedValueOnce(source)
    cropMock.mockResolvedValueOnce(cropped.bitmap)

    const outcome = await processBatchFiles(
      [{ id: 'shot-7', file: new File(['x'], 'portrait.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      {
        aspect: '1:1',
        smartCrop: true,
        crops: { 'shot-7': { x: 0.5, y: 0.25, w: 0.25, h: 0.5 } },
      },
    )

    expect(smartCropDetectMock).not.toHaveBeenCalled()
    expect(cropMock.mock.calls[0]![1].rect).toEqual({
      x: 0.5, y: 0.25, w: 0.25, h: 0.5,
    })
    expect(outcome.smartCropFallbacks).toBe(0)
    expect(outcome.successes).toHaveLength(1)
  })

  it('★ 批量超清放大：在当前尺寸上 2 倍放大，并继续走后续管线', async () => {
    const source = fakeDecoded('upscale-source')
    const enlarged = fakeReplaced('upscale-result', 2400, 1600)
    decodeMock.mockResolvedValueOnce(source)
    upscaleTargetMock.mockReturnValueOnce({ width: 2400, height: 1600 })
    upscaleToBitmapMock.mockResolvedValueOnce(enlarged.bitmap)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'small.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { upscale: true },
    )

    expect(upscaleTargetMock).toHaveBeenCalledWith(
      1200, 800, expect.objectContaining({ maxSide: expect.any(Number) }),
      2,
    )
    expect(upscaleToBitmapMock).toHaveBeenCalledWith(source.bitmap, 2400, 1600)
    expect(outcome.successes[0]).toMatchObject({ width: 2400, height: 1600 })
    expect(outcome.upscaleSkipped).toBe(0)
    expect(source.bitmap.close).toHaveBeenCalledTimes(1)
    expect(enlarged.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('★ 批量超清放大可选 4×，倍数原样交给目标尺寸计算', async () => {
    const source = fakeDecoded('upscale-4x-source')
    const enlarged = fakeReplaced('upscale-4x-result', 4242, 2828)
    decodeMock.mockResolvedValueOnce(source)
    upscaleTargetMock.mockReturnValueOnce({ width: 4242, height: 2828 })
    upscaleToBitmapMock.mockResolvedValueOnce(enlarged.bitmap)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'small.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { upscale: true, upscaleFactor: 4 },
    )

    expect(upscaleTargetMock).toHaveBeenCalledWith(
      1200, 800, expect.objectContaining({ maxSide: expect.any(Number) }),
      4,
    )
    expect(upscaleToBitmapMock).toHaveBeenCalledWith(source.bitmap, 4242, 2828)
    expect(outcome.successes[0]).toMatchObject({ width: 4242, height: 2828 })
  })

  it('★ 批量超清放大超限：保留原尺寸并单独计数，不中断整批', async () => {
    const source = fakeDecoded('too-large-to-upscale')
    decodeMock.mockResolvedValueOnce(source)
    upscaleTargetMock.mockReturnValueOnce(null)

    const outcome = await processBatchFiles(
      [{ id: '1', file: new File(['x'], 'huge.jpg', { type: 'image/jpeg' }) }],
      {} as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { upscale: true },
    )

    expect(upscaleToBitmapMock).not.toHaveBeenCalled()
    expect(outcome.successes[0]).toMatchObject({ width: 1200, height: 800 })
    expect(outcome.upscaleSkipped).toBe(1)
  })

  it('★ 批量附带 XMP：每张成片有同名调色旁车，并写进 ZIP', async () => {
    const source = fakeDecoded('xmp-source')
    decodeMock.mockResolvedValueOnce(source)

    const outcome = await processBatchFiles(
      [{ id: 'xmp', file: new File(['x'], 'portrait.jpg', { type: 'image/jpeg' }) }],
      { ...ZERO, exposure: 24, temperature: 12 } as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
      undefined,
      null,
      null,
      { includeXmp: true },
    )

    expect(outcome.successes[0]).toMatchObject({
      filename: 'portrait_pinkrose.jpg',
      sidecar: 'portrait_pinkrose.xmp',
    })
    const zipBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(outcome.archive!)
    })
    const zipText = new TextDecoder().decode(zipBytes)
    expect(zipText).toContain('portrait_pinkrose.xmp')
    expect(zipText).toContain('pinkrose:exposure="24"')
    expect(zipText).toContain('pinkrose:temperature="12"')
    expect(zipText).toContain('crs:Exposure2012="1.2"')
  })

  it('★ 每张照片可以读取自己的 XMP，优先于整批统一参数', async () => {
    const source = fakeDecoded('sidecar-source')
    decodeMock.mockResolvedValueOnce(source)
    const sidecar = fakeSidecar([
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:Exposure2012="1.5" />
        </rdf:RDF>
      </x:xmpmeta>`,
    ].join(''))

    const outcome = await processBatchFiles(
      [{ id: 'sidecar', file: new File(['x'], 'shot.jpg'), sidecar }],
      { ...ZERO, exposure: 5 } as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
    )

    expect(renderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ exposure: 30 }),
      0,
    )
    expect(outcome.sidecarImported).toBe(1)
    expect(outcome.sidecarErrors).toEqual([])
  })

  it('★ XMP 读不出来时保留统一参数，并如实报告旁车错误', async () => {
    const source = fakeDecoded('bad-sidecar-source')
    decodeMock.mockResolvedValueOnce(source)
    const sidecar = fakeSidecar('<not-xmp />', 'bad.xmp')

    const outcome = await processBatchFiles(
      [{ id: 'bad-sidecar', file: new File(['x'], 'bad.jpg'), sidecar }],
      { ...ZERO, exposure: 12 } as never,
      { format: 'image/jpeg', qualityPct: 90, longEdge: null },
      () => {},
    )

    expect(renderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ exposure: 12 }),
      0,
    )
    expect(outcome.sidecarImported).toBe(0)
    expect(outcome.sidecarErrors?.[0]).toContain('bad.jpg')
    expect(outcome.sidecarErrors?.[0]).toContain('XMP')
  })
})
