import {
  clampAdjustments, PARAM_KEYS, ZERO, type Adjustments,
} from '../../shared/adjustments.ts'
import {
  MAX_PRESET_NAME, MAX_PRESETS, presetNameOk, samePresetName, type PresetMeta,
} from '../../shared/preset.ts'

export const PRESET_FILE_FORMAT = 'pinkrose-presets'
export const PRESET_FILE_VERSION = 1
const PINKROSE_XMP_NS = 'https://pinkrose.app/ns/xmp/1.0/'

export type PresetTransfer = {
  name: string
  params: Adjustments
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function presetExportFilename(now = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-presets-${stamp}.json`
}

export function presetXmpFilename(now = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-look-${stamp}.xmp`
}

export function serializePresets(
  presets: readonly Pick<PresetMeta, 'name' | 'params'>[],
  now = new Date(),
): string {
  return JSON.stringify({
    format: PRESET_FILE_FORMAT,
    version: PRESET_FILE_VERSION,
    exportedAt: now.toISOString(),
    presets: presets.map(p => ({
      name: p.name,
      params: clampAdjustments(p.params),
    })),
  }, null, 2)
}

/**
 * 解析并完整校验导入文件。**不碰网络、不写名单**，调用方拿到数组后再逐套保存。
 * 空名、重名、数量超限、格式/版本不对都在这里挡掉，错误直接是可以展示的人话。
 */
export function parsePresetFile(text: string): PresetTransfer[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是有效的预设文件。')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('这个文件不是有效的预设文件。')
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== PRESET_FILE_FORMAT || obj.version !== PRESET_FILE_VERSION) {
    throw new Error('预设文件的格式或版本不支持。')
  }
  if (!Array.isArray(obj.presets) || obj.presets.length === 0) {
    throw new Error('这个预设文件里没有预设。')
  }
  if (obj.presets.length > MAX_PRESETS) {
    throw new Error(`一次最多导入 ${MAX_PRESETS} 套预设。`)
  }

  const seen: string[] = []
  const out: PresetTransfer[] = []
  for (const item of obj.presets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('预设文件里有损坏的一条。')
    }
    const p = item as Record<string, unknown>
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!presetNameOk(name)) {
      throw new Error(`预设名字要在 1–${MAX_PRESET_NAME} 个字之间。`)
    }
    if (seen.some(existing => samePresetName(existing, name))) {
      throw new Error(`文件里有重复的预设名「${name}」。`)
    }
    if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) {
      throw new Error(`「${name}」的参数不完整。`)
    }
    seen.push(name)
    out.push({ name, params: clampAdjustments(p.params as Adjustments) })
  }
  return out
}

const xmlEscape = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const shortNumber = (value: number): string =>
  String(Math.round(value * 10_000) / 10_000)

/** 把一套当前调色写成 XMP；自定义命名空间保存全部参数，crs 只带常见基础项。 */
export function serializePresetXmp(name: string, params: Adjustments): string {
  const p = clampAdjustments(params)
  const crs: readonly [string, number][] = [
    ['Exposure2012', p.exposure / 20],
    ['Contrast2012', p.contrast],
    ['Highlights2012', p.highlights],
    ['Shadows2012', p.shadows],
    ['Whites2012', p.whites],
    ['Blacks2012', p.blacks],
    ['Clarity2012', p.clarity],
    ['Texture', p.texture],
    ['Dehaze', p.dehaze],
    ['Vibrance', p.vibrance],
    ['Saturation', p.saturation],
    ['IncrementalTemperature', p.temperature],
    ['IncrementalTint', p.tint],
    ['SharpenAmount', p.sharpen * 1.5],
    ['LuminanceSmoothing', p.noiseReduction],
    ['GrainAmount', p.grain],
    ['PostCropVignetteAmount', p.vignette],
  ]
  const attrs = [
    `crs:PresetName="${xmlEscape(name)}"`,
    ...crs.map(([key, value]) => `crs:${key}="${shortNumber(value)}"`),
    ...(p.bwAmount === 100 ? [
      'crs:ConvertToGrayscale="True"',
      `crs:GrayMixerRed="${shortNumber(p.bwRed)}"`,
      `crs:GrayMixerGreen="${shortNumber(p.bwGreen)}"`,
      `crs:GrayMixerBlue="${shortNumber(p.bwBlue)}"`,
    ] : []),
    `pinkrose:Name="${xmlEscape(name)}"`,
    ...PARAM_KEYS.map(key => `pinkrose:${key}="${shortNumber(p[key])}"`),
  ].join('\n            ')
  return `<?xpacket begin="﻿"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:pinkrose="${PINKROSE_XMP_NS}"
      ${attrs} />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

const XMP_BASIC_MAP: readonly {
  key: keyof Adjustments
  attr: string
  scale?: number
}[] = [
  { key: 'exposure', attr: 'Exposure2012', scale: 20 },
  { key: 'contrast', attr: 'Contrast2012' },
  { key: 'highlights', attr: 'Highlights2012' },
  { key: 'shadows', attr: 'Shadows2012' },
  { key: 'whites', attr: 'Whites2012' },
  { key: 'blacks', attr: 'Blacks2012' },
  { key: 'clarity', attr: 'Clarity2012' },
  { key: 'texture', attr: 'Texture' },
  { key: 'dehaze', attr: 'Dehaze' },
  { key: 'vibrance', attr: 'Vibrance' },
  { key: 'saturation', attr: 'Saturation' },
  { key: 'temperature', attr: 'IncrementalTemperature' },
  { key: 'tint', attr: 'IncrementalTint' },
  { key: 'sharpen', attr: 'SharpenAmount', scale: 2 / 3 },
  { key: 'noiseReduction', attr: 'LuminanceSmoothing' },
  { key: 'grain', attr: 'GrainAmount' },
  { key: 'vignette', attr: 'PostCropVignetteAmount' },
]

const XMP_GRAY_MIX_MAP: readonly { key: keyof Adjustments; attr: string }[] = [
  { key: 'bwRed', attr: 'GrayMixerRed' },
  { key: 'bwGreen', attr: 'GrayMixerGreen' },
  { key: 'bwBlue', attr: 'GrayMixerBlue' },
]

/**
 * 解析单套 XMP。PinkRose 自己的文件优先读自定义命名空间，全部参数无损；
 * 其它软件只映射相机原始设置里能可靠对上的基础项。
 */
export function parsePresetXmp(text: string, fallbackName: string): PresetTransfer {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    throw new Error('这个文件不是可识别的 XMP 预设。')
  }
  if (doc.querySelector('parsererror') || !doc.getElementsByTagNameNS('*', 'xmpmeta').length) {
    throw new Error('这个文件不是可识别的 XMP 预设。')
  }
  const description = doc.getElementsByTagNameNS('*', 'Description')[0]
  if (!description) throw new Error('这个文件不是可识别的 XMP 预设。')

  const customPresent = PARAM_KEYS.some(key => description.hasAttribute(`pinkrose:${key}`))
  const params: Adjustments = { ...ZERO }
  let matched = 0
  if (customPresent) {
    for (const key of PARAM_KEYS) {
      const raw = description.getAttribute(`pinkrose:${key}`)
      if (raw === null || raw.trim() === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      params[key] = value
      matched++
    }
  } else {
    for (const item of XMP_BASIC_MAP) {
      const raw = description.getAttribute(`crs:${item.attr}`)
      if (raw === null || raw.trim() === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      params[item.key] = value * (item.scale ?? 1)
      matched++
    }
    const grayscale = description.getAttribute('crs:ConvertToGrayscale')
    if (grayscale?.toLowerCase() === 'true' || grayscale === '1') {
      params.bwAmount = 100
      matched++
    }
    for (const item of XMP_GRAY_MIX_MAP) {
      const raw = description.getAttribute(`crs:${item.attr}`)
      if (raw === null || raw.trim() === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      params[item.key] = value
      matched++
    }
  }
  if (matched === 0) throw new Error('这个 XMP 里没有可识别的调色项。')

  const fallback = fallbackName.replace(/\.[^.]+$/, '').trim().slice(0, MAX_PRESET_NAME)
    || defaultXmpName
  const customName = description.getAttribute('pinkrose:Name')?.trim()
    ?? description.getAttribute('crs:PresetName')?.trim()
  const name = customName && presetNameOk(customName) ? customName : fallback
  return { name, params: clampAdjustments(params) }
}

const defaultXmpName = '导入的 XMP'
