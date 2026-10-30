import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import { makeCanvas } from '../core/canvas'
import { autoAdjustments } from '../core/autoEnhance'
import {
  decodeImageFile, imageDecodeFailureText, type DecodedImage,
} from '../image/decode'
import { cropToBitmap } from '../image/crop'
import { resizeBitmap } from '../image/resize'
import { samplePixels } from '../image/sample'
import { readLensInfo } from '../core/photoInfo'
import { lensProfileAdjustments, matchLensProfile } from '../core/lensProfile'
import { customLensProfiles } from '../core/customLensProfiles'
import { selectSubjectToMask } from '../image/backgroundSelect'
import {
  replaceBackgroundToBitmap, resolveBackgroundFill, type BackgroundFill,
} from '../image/backgroundReplace'
import { transparentToBitmap } from '../image/transparency'
import { detectFaceInBitmap, detectFacesInBitmap } from '../image/faceDetect'
import { faceMask } from '../image/faceMask'
import { DEFAULT_SMOOTH_TEXTURE, smoothToBitmap } from '../image/smooth'
import { blemishToBitmap } from '../image/blemish'
import { faceLightToBitmap } from '../image/faceLight'
import { skinToneToBitmap } from '../image/skinTone'
import { faceShapeToBitmap } from '../image/faceShape'
import { duotonePixels, type DuotoneOptions } from '../image/duotone'
import { detectSubjectBox } from '../image/smartCrop'
import { smartCropRectForAspect } from '../core/smartCrop'
import { clampBatchCrop, cropPixels, type BatchCropRect } from '../core/batchCrop'
import { TonePipeline } from '../render/pipeline'
import { probeLimit, type RenderLimit } from '../render/limits'
import {
  MAX_UPSCALE_AREA, upscaleTarget, upscaleToBitmap,
} from '../image/upscale'
import {
  type WatermarkLogo, type WatermarkOptions,
} from '../image/watermark'
import {
  buildExportBlob, buildFilename, cropRectForAspect, exportSize, markExportCanvas,
  exportAspectRatio, type ExportAspect, type ExportOptions,
} from '../export/save'
import { buildZipBlob, type ZipEntry } from './zip'
import { parsePresetXmp, serializePresetXmp } from '../core/presetFile'

export type BatchInput = {
  id: string
  file: File
  /** 同目录同名 XMP；成功读取时优先于整批统一调色。 */
  sidecar?: File
}

export type BatchProgress = {
  completed: number
  total: number
  currentName: string
}

export type BatchSuccess = {
  id: string
  sourceName: string
  /** EXIF 拍摄时间（毫秒）；只用于作品来源元数据，缺失时不伪造。 */
  capturedAt?: number
  cameraMake?: string
  cameraModel?: string
  lensModel?: string
  filename: string
  bytes: number
  width: number
  height: number
  /** 成片 Blob，结果区可直接存进作品或单张下载。 */
  blob?: Blob
  /** 非 JPG/PNG 成片的作品集母版；作品服务只收 JPG/PNG。 */
  workBlob?: Blob
  /** 成片小图（data URL），结果区预览用；生成失败时为空。 */
  preview?: string
  /** 批量 ZIP 内附带的同名 XMP 调色旁车。 */
  sidecar?: string
  /** 这张 RAW 是用相机内嵌 JPEG 预览进入处理的。 */
  rawPreview?: { width: number; height: number }
}

export type BatchFailure = {
  id: string
  sourceName: string
  message: string
}

export type BatchOutcome = {
  archive: Blob | null
  archiveName: string
  successes: BatchSuccess[]
  failures: BatchFailure[]
  /** 选了人像精修、但这张没找到正脸而原样保留的张数。 */
  portraitSkipped: number
  /** 人像精修实际覆盖的人脸数；单人脸照片通常等于处理成功张数。 */
  portraitFaces?: number
  /** 选了智能构图、但这张没认出主体而退回居中裁切的张数。 */
  smartCropFallbacks: number
  /** 选了超清放大、但这张超出上限或没放大成的张数。 */
  upscaleSkipped: number
  /** 选了自动镜头校正、EXIF 认出来并套上配置的张数。 */
  lensMatched?: number
  /** 选了自动镜头校正、但 EXIF 没认出来（保留原参数）的张数。 */
  lensSkipped?: number
  /** RAW 本机转换器不可用、改用相机内嵌 JPEG 预览的张数。 */
  rawPreviewCount?: number
  /** 按拍摄日期命名、但 EXIF 没日期而使用文件修改日期的张数。 */
  dateFallbackCount?: number
  /** 成功应用各自 XMP 旁车的张数。 */
  sidecarImported?: number
  /** 读取失败的 XMP 旁车；对应照片保留整批统一调色。 */
  sidecarErrors?: string[]
  cancelled: boolean
}

export type BatchExtras = {
  /** 非 original 时逐张居中裁成统一画幅。 */
  aspect?: ExportAspect
  /** 每张照片先按自己的直方图做保守自动校正，再套所选预设。 */
  autoEnhance?: boolean
  /** 每张照片按 EXIF 认镜头，自动覆盖畸变 / 暗角 / 色差三根。 */
  autoLens?: boolean
  /**
   * 输出命名：默认沿用源文件名；`sequence` = 前缀 + 三位序号；
   * `date` = 前缀 + 拍摄日期 + 三位序号。
   */
  rename?: { mode: 'source' | 'sequence' | 'date'; prefix?: string }
  /** 可选 Lut；和参数预设叠加，强度按 0~100。 */
  lut?: { cube: Cube; amount: number } | null
  /** 整批统一方向：90° 的倍数，可叠加水平 / 垂直镜像。 */
  rotateTurns?: number
  flipH?: boolean
  flipV?: boolean
  /** 逐张识别主体并换背景；透明背景会自动改用 PNG 导出。 */
  background?: BatchBackground
  /** 逐张识别正脸后做轻量人像精修；没找到脸的照片保持原样。 */
  portrait?: BatchPortrait
  /** 非原图比例时：先用主体检测把裁切中心移到主体上，失败就居中。 */
  smartCrop?: boolean
  /**
   * 逐张手动取景：key = BatchInput.id，value = 相对**转向后**照片的归一化框。
   * 有手动取景的照片不再跑主体检测，直接按用户框裁；其余照片仍走
   * smartCrop / 居中。
   */
  crops?: Record<string, BatchCropRect>
  /** 本机超清放大；超出目标面积 / 设备上限时保留原尺寸。 */
  upscale?: boolean
  /** 放大倍数，默认 2；编辑器可选 4。 */
  upscaleFactor?: number
  /** 整批统一双色调；在水印之前套到合成结果上。 */
  duotone?: DuotoneOptions
  /** 在 ZIP 中为每张成片附一份同名 XMP；记录该张实际套用的调色参数。 */
  includeXmp?: boolean
}

export type BatchBackgroundKind =
  | 'off' | 'transparent' | 'white' | 'blue' | 'gray' | 'blur' | 'color' | 'image'

export type BatchBackground = {
  kind: BatchBackgroundKind
  /** `kind: 'color'` 时使用；非法值由像素层回退为白色。 */
  color?: string
  /** `kind: 'image'` 时使用；由调用方负责在整批结束后关闭。 */
  bitmap?: ImageBitmap
  /** 背景图文件名，只给界面显示用。 */
  name?: string
}

export type BatchPortrait = {
  /** 合影：肤色检测到的多张脸都修；默认 false，保持原来的单脸行为。 */
  multiFace?: boolean
  /** 瘦脸 0~100；0 = 不动。 */
  slim?: number
  /** 瘦颈 0~100；0 = 不动。 */
  neck?: number
  /** 双下巴 0~100；0 = 不动。 */
  doubleChin?: number
  /** 直角肩 0~100；0 = 不动。 */
  shoulder?: number
  /** 微笑 0~100；0 = 不动。 */
  smile?: number
  /** 磨皮 0~100；0 = 不动。 */
  smooth?: number
  /** 面部补光 0~100；0 = 不动。 */
  light?: number
  /** 美白 0~100；0 = 不动。 */
  whiten?: number
  /** 红润 0~100；0 = 不动。 */
  rosy?: number
  /** 自动找小斑点并修补。 */
  blemish?: boolean
}

/**
 * 把界面上的「背景」翻成像素层认的合成参数。
 * 透明返回 null（走 alpha 擦除），保持原样也返回 null（调用方应跳过整段）。
 */
export function batchBackgroundFill(background: BatchBackground): BackgroundFill | null {
  if (background.kind === 'off' || background.kind === 'transparent') return null
  if (background.kind === 'image') {
    return background.bitmap
      ? resolveBackgroundFill('image', '#ffffff', background.bitmap)
      : null
  }
  return resolveBackgroundFill(background.kind, background.color ?? '#ffffff', null)
}

/** 一次最多 20 张：每张都可能在 GPU 里占几十 MB，再往上浏览器标签页容易吃紧。 */
export const MAX_BATCH_FILES = 20

/** 只是给失败文案分流用，不会透给用户。 */
class NoSubjectError extends Error {}

/** 结果区的小缩略图；浏览器不支持 toDataURL 或画布被污染时安静地跳过。 */
function previewDataUrl(source: HTMLCanvasElement): string | undefined {
  try {
    if (typeof source.toDataURL !== 'function') return undefined
    const side = 160
    const scale = Math.min(1, side / Math.max(1, source.width, source.height))
    const { canvas, ctx } = makeCanvas(
      Math.max(1, Math.round(source.width * scale)),
      Math.max(1, Math.round(source.height * scale)),
      '画不了批量缩略图',
    )
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  } catch {
    return undefined
  }
}

function batchFailureText(
  stage: 'decode' | 'crop' | 'portrait' | 'background' | 'duotone' | 'export',
  error: unknown,
  file: File,
): string {
  if (stage === 'decode') return imageDecodeFailureText(file)
  if (stage === 'crop') return '这张没能按画幅裁切，已跳过；其它照片照常处理。'
  if (stage === 'portrait') return '这张的人像精修没做成，已跳过；其它照片照常处理。'
  if (stage === 'duotone') return '这张的双色调没做成，已跳过；其它照片照常处理。'
  if (stage === 'background') {
    return error instanceof NoSubjectError
      ? '这张没认出主体，已跳过；其它照片照常处理。'
      : '这张没能自动换背景，已跳过；其它照片照常处理。'
  }
  return '这张图没能导出，换一张试试'
}

/**
 * 逐张人像精修。只改有人脸的照片；没脸的照片原样返回并记一笔 skip。
 * 中间结果按顺序替换，出错时把已经生成的新位图还回去，旧底图不动。
 */
async function applyBatchPortrait(
  source: DecodedImage,
  portrait: BatchPortrait,
): Promise<{ decoded: DecodedImage; faceFound: boolean; faces: number }> {
  const single = portrait.multiFace ? null : await detectFaceInBitmap(source.bitmap)
  const faces = portrait.multiFace
    ? await detectFacesInBitmap(source.bitmap, 6)
    : single ? [single] : []
  if (faces.length === 0) return { decoded: source, faceFound: false, faces: 0 }

  let current = source.bitmap
  let ownsCurrent = false
  const outFaces = [...faces]
  const replace = (next: ImageBitmap) => {
    if (ownsCurrent) current.close()
    current = next
    ownsCurrent = true
  }

  try {
    if ((portrait.slim ?? 0) > 0 || (portrait.neck ?? 0) > 0
      || (portrait.doubleChin ?? 0) > 0 || (portrait.shoulder ?? 0) > 0
      || (portrait.smile ?? 0) > 0) {
      const shaped = await faceShapeToBitmap(current, outFaces[0]!, {
        slim: portrait.slim,
        neck: portrait.neck,
        doubleChin: portrait.doubleChin,
        shoulder: portrait.shoulder,
        smile: portrait.smile,
      })
      if (shaped.changed > 0) {
        replace(shaped.bitmap)
        outFaces[0] = shaped.face
      } else {
        shaped.bitmap.close()
      }
      // 合影里的第二张及以后只做脸局部塑形；瘦颈 / 肩线 / 双下巴是
      // 全身关系，重复对每张脸做会把身体拉好几次。
      if (portrait.multiFace && ((portrait.slim ?? 0) > 0 || (portrait.smile ?? 0) > 0)) {
        for (let i = 1; i < outFaces.length; i++) {
          const local = await faceShapeToBitmap(current, outFaces[i]!, {
            slim: portrait.slim,
            smile: portrait.smile,
          })
          if (local.changed > 0) {
            replace(local.bitmap)
            outFaces[i] = local.face
          } else {
            local.bitmap.close()
          }
        }
      }
    }
    if ((portrait.smooth ?? 0) > 0) {
      let mask: Uint8Array
      if (outFaces.length === 1) {
        mask = faceMask(current.width, current.height, outFaces[0]!)
      } else {
        mask = new Uint8Array(current.width * current.height)
        for (const face of outFaces) {
          const one = faceMask(current.width, current.height, face)
          for (let i = 0; i < mask.length; i++) {
            if (one[i]! > mask[i]!) mask[i] = one[i]!
          }
        }
      }
      const made = await smoothToBitmap(current, mask, {
        strength: portrait.smooth,
        texture: DEFAULT_SMOOTH_TEXTURE,
      })
      replace(made.bitmap)
    }
    if (portrait.blemish) {
      for (const face of outFaces) {
        const made = await blemishToBitmap(current, face, { strength: 70 })
        if (made.spots > 0) replace(made.bitmap)
        else made.bitmap.close()
      }
    }
    if ((portrait.light ?? 0) > 0) {
      for (const face of outFaces) {
        const made = await faceLightToBitmap(current, face, { strength: portrait.light })
        if (made.changed > 0) replace(made.bitmap)
        else made.bitmap.close()
      }
    }
    if ((portrait.whiten ?? 0) > 0 || (portrait.rosy ?? 0) > 0) {
      for (const face of outFaces) {
        const made = await skinToneToBitmap(current, face, {
          whiten: portrait.whiten, rosy: portrait.rosy,
        })
        if (made.changed > 0) replace(made.bitmap)
        else made.bitmap.close()
      }
    }
    if (!ownsCurrent) return { decoded: source, faceFound: true, faces: outFaces.length }
    source.bitmap.close()
    return {
      decoded: { bitmap: current, width: current.width, height: current.height },
      faceFound: true,
      faces: outFaces.length,
    }
  } catch (error) {
    if (ownsCurrent) current.close()
    throw error
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function batchArchiveName(now = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-batch-${stamp}.zip`
}

/** 同名输出不能互相覆盖：`photo_pinkrose.jpg` → `photo_pinkrose_2.jpg`。 */
export function uniqueBatchFilename(filename: string, used: Set<string>): string {
  const key = filename.toLowerCase()
  if (!used.has(key)) {
    used.add(key)
    return filename
  }
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let n = 2
  while (used.has(`${stem}_${n}${ext}`.toLowerCase())) n++
  const next = `${stem}_${n}${ext}`
  used.add(next.toLowerCase())
  return next
}

function formatExtension(format: ExportOptions['format']): string {
  return format === 'image/png' ? 'png'
    : format === 'image/webp' ? 'webp'
      : format === 'image/avif' ? 'avif'
        : format === 'image/heic' ? 'heic'
          : format === 'image/tiff' ? 'tif'
            : 'jpg'
}

function cleanBatchPrefix(prefix: string | undefined): string {
  return (prefix ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 40) || 'PinkRose'
}

/** 前缀 + 三位序号；清掉文件系统不允许的字符，空前缀退回 PinkRose。 */
export function batchSequenceFilename(
  prefix: string | undefined, index: number, format: ExportOptions['format'],
): string {
  const clean = cleanBatchPrefix(prefix)
  const n = Math.max(1, Math.floor(index))
  return `${clean}-${String(n).padStart(3, '0')}.${formatExtension(format)}`
}

function localDateKey(value: number): string {
  const date = new Date(Number.isFinite(value) ? value : Date.now())
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('')
}

/** 拍摄日期来自 EXIF 时直接取年月日；缺失时用文件修改日期。 */
export function batchDatedFilename(
  prefix: string | undefined,
  takenAt: string | null | undefined,
  fallbackModified: number,
  index: number,
  format: ExportOptions['format'],
): string {
  const match = takenAt?.match(/^(\d{4})[-:](\d{2})[-:](\d{2})/)
  const day = match ? `${match[1]}${match[2]}${match[3]}` : localDateKey(fallbackModified)
  const n = Math.max(1, Math.floor(index))
  return `${cleanBatchPrefix(prefix)}-${day}-${String(n).padStart(3, '0')}.${formatExtension(format)}`
}

/**
 * 逐张处理，**单张失败不终止整批**。所有成功项最后打进一个 store-only ZIP。
 *
 * 一张照片的完整路径和单张导出完全一样：
 * 解码 →（按需）缩到输出长边 → WebGL 调色 → 写回 EXIF / 编码。
 * 拼包只发生在最后，处理中不在内存里同时留二十张全尺寸位图。
 */
export async function processBatchFiles(
  inputs: readonly BatchInput[],
  adjustments: Adjustments,
  options: ExportOptions,
  onProgress: (progress: BatchProgress) => void,
  signal?: AbortSignal,
  watermark?: WatermarkOptions | null,
  logo?: WatermarkLogo | null,
  extras: BatchExtras = {},
): Promise<BatchOutcome> {
  if (inputs.length === 0) throw new Error('先选几张照片')

  const batchUpscaleLimit: RenderLimit | null = extras.upscale
    ? (probeLimit() ?? { maxSide: 8192, maxArea: MAX_UPSCALE_AREA })
    : null
  const batchUpscaleFactor = extras.upscaleFactor ?? 2
  const canvas = document.createElement('canvas')
  const pipe = new TonePipeline(canvas)
  if (extras.lut) pipe.setLut(extras.lut.cube)
  const compositeCanvas = document.createElement('canvas')
  const duotoneCanvas = document.createElement('canvas')
  const successes: BatchSuccess[] = []
  const failures: BatchFailure[] = []
  const zipEntries: ZipEntry[] = []
  const usedNames = new Set<string>()
  let cancelled = false
  let portraitSkipped = 0
  let portraitFaces = 0
  let smartCropFallbacks = 0
  let upscaleSkipped = 0
  let lensMatched = 0
  let lensSkipped = 0
  let rawPreviewCount = 0
  let dateFallbackCount = 0
  let sidecarImported = 0
  const sidecarErrors: string[] = []

  onProgress({ completed: 0, total: inputs.length, currentName: inputs[0]!.file.name })

  try {
    for (let index = 0; index < inputs.length; index++) {
      if (signal?.aborted) { cancelled = true; break }
      const input = inputs[index]!
      onProgress({ completed: index, total: inputs.length, currentName: input.file.name })
      let decoded: DecodedImage | null = null
      let rawPreview: { width: number; height: number } | null = null
      let stage: 'decode' | 'crop' | 'portrait' | 'background' | 'duotone' | 'export' = 'decode'
      try {
        decoded = await decodeImageFile(input.file)
        if (decoded.rawPreview) {
          rawPreview = decoded.rawPreview
          rawPreviewCount++
        }
        if (signal?.aborted) { cancelled = true; break }

        if (extras.rotateTurns || extras.flipH || extras.flipV) {
          const turned = await cropToBitmap(decoded.bitmap, {
            rect: { x: 0, y: 0, w: 1, h: 1 },
            angle: 0,
            flipH: !!extras.flipH,
            flipV: !!extras.flipV,
          }, extras.rotateTurns ?? 0)
          decoded.bitmap.close()
          decoded = { bitmap: turned, width: turned.width, height: turned.height }
        }
        if (signal?.aborted) { cancelled = true; break }

        const aspect = extras.aspect ?? 'original'
        if (aspect !== 'original') {
          stage = 'crop'
          const manual = extras.crops?.[input.id]
          let rect = manual
            ? cropPixels(clampBatchCrop(manual), decoded.width, decoded.height)
            : cropRectForAspect(decoded.width, decoded.height, aspect)
          // 手动取景优先：用户已经亲自决定了位置和范围，不再用主体检测覆盖。
          if (!manual && extras.smartCrop) {
            try {
              const subject = await detectSubjectBox(decoded.bitmap)
              if (signal?.aborted) { cancelled = true; break }
              if (subject) {
                rect = smartCropRectForAspect(
                  decoded.width, decoded.height, exportAspectRatio(aspect), subject,
                )
              } else {
                smartCropFallbacks++
              }
            } catch (error) {
              console.warn('批量智能构图没认出主体，退回居中裁切', error)
              smartCropFallbacks++
            }
          }
          if (signal?.aborted) { cancelled = true; break }
          const cropped = await cropToBitmap(decoded.bitmap, {
            rect: {
              x: rect.x / decoded.width,
              y: rect.y / decoded.height,
              w: rect.w / decoded.width,
              h: rect.h / decoded.height,
            },
            angle: 0,
          }, 0)
          decoded.bitmap.close()
          decoded = { bitmap: cropped, width: cropped.width, height: cropped.height }
        }
        if (signal?.aborted) { cancelled = true; break }

        const size = exportSize(decoded.width, decoded.height, options.longEdge)
        if (size.width !== decoded.width || size.height !== decoded.height) {
          const resized = await resizeBitmap(decoded.bitmap, size.width, size.height)
          decoded.bitmap.close()
          decoded = { bitmap: resized, width: size.width, height: size.height }
        }
        if (signal?.aborted) { cancelled = true; break }

        if (extras.upscale && batchUpscaleLimit) {
          const target = upscaleTarget(
            decoded.width, decoded.height, batchUpscaleLimit, batchUpscaleFactor,
          )
          if (!target) {
            upscaleSkipped++
          } else {
            try {
              const enlarged = await upscaleToBitmap(
                decoded.bitmap, target.width, target.height,
              )
              if (signal?.aborted) {
                enlarged.close()
                cancelled = true
                break
              }
              decoded.bitmap.close()
              decoded = { bitmap: enlarged, width: enlarged.width, height: enlarged.height }
            } catch (error) {
              console.warn('批量超清放大没成，保留原尺寸', input.file.name, error)
              upscaleSkipped++
            }
          }
        }
        if (signal?.aborted) { cancelled = true; break }

        let params = adjustments
        if (input.sidecar) {
          try {
            params = (await parsePresetXmp(
              await input.sidecar.text(),
              input.sidecar.name,
            )).params
            sidecarImported++
          } catch (error) {
            const message = error instanceof Error ? error.message : '这个 XMP 读不出来'
            sidecarErrors.push(`${input.file.name}：${message}`)
            console.warn('批量 XMP 旁车没读出来，保留统一调色', input.file.name, error)
          }
        }
        if (extras.autoEnhance) {
          params = { ...params, ...autoAdjustments(samplePixels(decoded.bitmap)) }
        }
        if (extras.autoLens) {
          try {
            const info = await readLensInfo(input.file)
            const match = matchLensProfile(info, customLensProfiles())
            if (match) {
              params = { ...params, ...lensProfileAdjustments(match.profile, match.focalMm) }
              lensMatched++
            } else {
              lensSkipped++
            }
          } catch (error) {
            // 读 EXIF 失败只影响这一张的镜头校正，不该让整批失败。
            console.warn('批量镜头配置没读出来，保留原参数', input.file.name, error)
            lensSkipped++
          }
        }
        if (signal?.aborted) { cancelled = true; break }

        if (extras.portrait && (
          (extras.portrait.smooth ?? 0) > 0
          || (extras.portrait.light ?? 0) > 0
          || (extras.portrait.whiten ?? 0) > 0
          || (extras.portrait.rosy ?? 0) > 0
          || (extras.portrait.smile ?? 0) > 0
          || extras.portrait.blemish
        )) {
          stage = 'portrait'
          const retouched = await applyBatchPortrait(decoded, extras.portrait)
          if (signal?.aborted) {
            if (retouched.decoded !== decoded) retouched.decoded.bitmap.close()
            cancelled = true
            break
          }
          if (!retouched.faceFound) portraitSkipped++
          else portraitFaces += retouched.faces
          decoded = retouched.decoded
        }
        if (signal?.aborted) { cancelled = true; break }

        let outputFormat = options.format
        const background = extras.background
        let subjectMask: Uint8Array | null = null
        if (background && background.kind !== 'off') {
          stage = 'background'
          if (background.kind === 'image' && !background.bitmap) {
            throw new Error('批量背景图还没准备好')
          }
          subjectMask = new Uint8Array(decoded.width * decoded.height)
          const selection = await selectSubjectToMask(decoded.bitmap, subjectMask)
          if (signal?.aborted) { cancelled = true; break }
          if (selection.subjectRatio < 0.02 || selection.subjectRatio > 0.95) {
            throw new NoSubjectError('这张没认出主体')
          }
          if (background.kind === 'transparent' && outputFormat !== 'image/tiff') {
            outputFormat = 'image/png'
          }
        }
        if (signal?.aborted) { cancelled = true; break }

        stage = 'export'
        pipe.setImage(decoded)
        pipe.resizeToImage()
        pipe.render(params, extras.lut?.amount ?? 0)

        // 先调主体、再合成背景：证件蓝 / 纯白这类背景不该被风格预设一起染色。
        let prepared = canvas
        if (background && background.kind !== 'off' && subjectMask) {
          stage = 'background'
          const compositeCtx = compositeCanvas.getContext('2d')
          if (!compositeCtx) throw new Error('这个浏览器做不了批量换背景')
          compositeCanvas.width = canvas.width
          compositeCanvas.height = canvas.height
          compositeCtx.clearRect(0, 0, canvas.width, canvas.height)
          compositeCtx.drawImage(canvas, 0, 0)
          const fill = batchBackgroundFill(background)
          const next = fill
            ? await replaceBackgroundToBitmap(compositeCanvas, subjectMask, fill)
            : await transparentToBitmap(compositeCanvas, subjectMask)
          if (signal?.aborted) {
            next.bitmap.close()
            cancelled = true
            break
          }
          compositeCtx.clearRect(0, 0, canvas.width, canvas.height)
          compositeCtx.drawImage(next.bitmap, 0, 0)
          next.bitmap.close()
          prepared = compositeCanvas
        }
        if (extras.duotone && extras.duotone.intensity > 0) {
          stage = 'duotone'
          const toneCtx = duotoneCanvas.getContext('2d', {
            colorSpace: 'srgb', willReadFrequently: true,
          })
          if (!toneCtx) throw new Error('这个浏览器做不了批量双色调')
          duotoneCanvas.width = prepared.width
          duotoneCanvas.height = prepared.height
          toneCtx.clearRect(0, 0, prepared.width, prepared.height)
          toneCtx.drawImage(prepared, 0, 0)
          const image = toneCtx.getImageData(0, 0, prepared.width, prepared.height)
          duotonePixels(image.data, prepared.width, prepared.height, extras.duotone)
          toneCtx.putImageData(image, 0, 0)
          prepared = duotoneCanvas
        }
        const output = markExportCanvas(prepared, watermark, logo)
        const preview = previewDataUrl(output)
        stage = 'export'
        const blob = await buildExportBlob(
          output,
          input.file,
          outputFormat,
          options.qualityPct / 100,
          options.preserveMetadata !== false,
          options.colorSpace ?? 'srgb',
          options.preserveLocation !== false,
          { creator: options.creator, copyright: options.copyright },
        )
        const workBlob = outputFormat !== 'image/jpeg' && outputFormat !== 'image/png'
          ? await buildExportBlob(
              output,
              input.file,
              'image/jpeg',
              0.95,
              options.preserveMetadata !== false,
              'srgb',
              options.preserveLocation !== false,
              { creator: options.creator, copyright: options.copyright },
            )
          : undefined
        if (signal?.aborted) { cancelled = true; break }

        const lensInfo = await readLensInfo(input.file).catch(() => null)
        const takenAt = lensInfo?.takenAt ?? null
        let baseName: string
        if (extras.rename?.mode === 'date') {
          if (!takenAt) dateFallbackCount++
          baseName = batchDatedFilename(
            extras.rename.prefix,
            takenAt,
            input.file.lastModified,
            index + 1,
            outputFormat,
          )
        } else {
          baseName = extras.rename?.mode === 'sequence'
            ? batchSequenceFilename(extras.rename.prefix, index + 1, outputFormat)
            : buildFilename(input.file.name, outputFormat)
        }
        const filename = uniqueBatchFilename(baseName, usedNames)
        let sidecar: string | undefined
        if (extras.includeXmp && !signal?.aborted) {
          sidecar = `${filename.replace(/\.[^.]+$/, '')}.xmp`
          const profileName = baseName.replace(/\.[^.]+$/, '').slice(0, 120) || 'PinkRose'
          zipEntries.push({
            name: sidecar,
            data: new TextEncoder().encode(serializePresetXmp(profileName, params)),
          })
        }
        const data = new Uint8Array(await blob.arrayBuffer())
        zipEntries.push({ name: filename, data })
        successes.push({
          id: input.id,
          sourceName: input.file.name,
          ...(lensInfo?.takenAtMs ? { capturedAt: lensInfo.takenAtMs } : {}),
          ...(lensInfo?.make ? { cameraMake: lensInfo.make } : {}),
          ...(lensInfo?.model ? { cameraModel: lensInfo.model } : {}),
          ...(lensInfo?.lens ? { lensModel: lensInfo.lens } : {}),
          filename,
          bytes: data.length,
          width: decoded.width,
          height: decoded.height,
          blob,
          ...(workBlob ? { workBlob } : {}),
          preview,
          ...(sidecar ? { sidecar } : {}),
          ...(rawPreview ? { rawPreview } : {}),
        })
      } catch (error) {
        console.error('批量处理单张失败', input.file.name, error)
        failures.push({
          id: input.id,
          sourceName: input.file.name,
          message: batchFailureText(stage, error, input.file),
        })
      } finally {
        decoded?.bitmap.close()
      }
      onProgress({ completed: index + 1, total: inputs.length, currentName: input.file.name })
    }
  } finally {
    pipe.dispose()
  }

  return {
    archive: zipEntries.length > 0 ? buildZipBlob(zipEntries) : null,
    archiveName: batchArchiveName(),
    successes,
    failures,
    portraitSkipped,
    portraitFaces,
    smartCropFallbacks,
    upscaleSkipped,
    lensMatched,
    lensSkipped,
    rawPreviewCount,
    dateFallbackCount,
    sidecarImported,
    sidecarErrors,
    cancelled,
  }
}
