import { useCallback, useRef, useState } from 'react'
import type { RetouchScene } from '../ui/Canvas'
import type { GradientScene } from '../ui/Canvas'
import {
  adjustMaskEdge, createMask, defaultBrushRadius, featherMask, invertMask, maskBounds,
  scaleMask, type BrushMode,
} from '../core/retouch'
import {
  DEFAULT_LINEAR_GRADIENT, DEFAULT_RADIAL_GRADIENT, fillGradientMask,
  type GradientKind, type GradientSpec,
} from '../core/gradientMask'
import {
  localAdjustToBitmap, type AegyoSalShadeId, type ContourShadeId,
  type EyelinerShadeId, type EyeShadowShadeId, type EyebrowShadeId,
  type HairShadeId, type HighlightShadeId, type IrisShadeId,
  type LocalAdjustOptions, type LocalEffect, type ToneRange,
} from '../image/localAdjust'
import { detectFaceInBitmap } from '../image/faceDetect'
import { selectFacePartToMask } from '../image/facePartMask'
import { selectSubjectToMask } from '../image/backgroundSelect'
import { selectSkyToMask } from '../image/skyMask'
import { decodeMask, encodeMask, isLocalLayer, preloadLocalMasks } from '../image/localLayer'
import {
  maskFromColorSource, prepareColorSource, sampleColorSource, type ColorSource,
} from '../image/colorRange'
import {
  maskFromLuminanceSource, prepareLuminanceSource,
} from '../image/luminanceRange'
import type { Rgb } from '../core/colorMatch'
import {
  LOCAL_LAYERS_MAX, LOCAL_MASKS_TOTAL_MAX, isNoopLocalOptions,
  normalizeLocalAdjustOptions, type LocalLayer,
} from '../../shared/local.ts'
import type { EditLayer } from '../../shared/layers.ts'
import {
  applyBaseEdit, applyLayersEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps,
} from './baseEdit'

/**
 * **局部调整画笔那一簇**（★ 2026-10-17）—— 工具行「局部」的全部行为。
 *
 * 和点修 / 磨皮完全同构：现场 = 掩码（自由涂抹或线性 / 径向渐变）+ 笔刷 +
 * 调色四值或牙齿 / 亮眼 / 祛皱预设；掩码在 ref 里，提交走 `app/baseEdit.ts` 的共享骨架。
 * 只改当前这一版的底图、账本记一笔、不进转盘、不写对话、不碰全局 `params`。
 *
 * 蒙版可从涂抹 / 线性 / 径向 / 色彩范围 / 明暗范围生成；也可存成可回改局部层。
 */
const MAX_LOCAL_PIXELS = 1_200_000
const LOCAL_VEIL_PIXELS = 150_000

export type LocalDeps = BaseEditToolDeps & {
  layers: readonly EditLayer[]
  setLayers: (layers: EditLayer[]) => void
}

type LocalSceneState = {
  radius: number
  maskFeather: number
  mode: BrushMode
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  whites: number
  blacks: number
  dehaze: number
  highlights: number
  shadows: number
  vibrance: number
  clarity: number
  effect: LocalEffect
  effectStrength: number
  toneRange: ToneRange
  angle: number
  hairShade: HairShadeId
  eyeShadowShade: EyeShadowShadeId
  eyebrowShade: EyebrowShadeId
  contourShade: ContourShadeId
  highlightShade: HighlightShadeId
  aegyoSalShade: AegyoSalShadeId
  eyelinerShade: EyelinerShadeId
  irisShade: IrisShadeId
  maskKind: 'brush' | GradientKind | 'color' | 'luminance'
  gradient: GradientSpec
  colorTarget: Rgb | null
  colorConnected: boolean
  colorSeed: { x: number; y: number } | null
  colorTolerance: number
  colorFeather: number
  luminanceRange: ToneRange
  luminanceWidth: number
  luminanceFeather: number
  /** 渐变 / 色彩范围的反选；涂抹是在掩码上直接翻，不靠这个标志。 */
  invert: boolean
  /** 蒙版扩展 / 收缩（图片像素，正数外扩、负数内收）。 */
  edge: number
  /** 整层不透明度 0–100；100 = 全量。 */
  opacity: number
  /** 正在等用户点画面上的颜色。 */
  colorPick: boolean
  dirty: boolean
}

function sceneChanged(scene: LocalSceneState): boolean {
  return scene.effect === 'tone'
    ? scene.exposure !== 0 || scene.contrast !== 0
      || scene.saturation !== 0 || scene.temperature !== 0
      || scene.tint !== 0
      || scene.whites !== 0 || scene.blacks !== 0
      || scene.dehaze !== 0
      || scene.highlights !== 0 || scene.shadows !== 0
      || scene.vibrance !== 0 || scene.clarity !== 0
    : scene.effectStrength > 0
}

/** 现场 → 局部层参数；只保留当前效果真正用到的那几项。 */
function optionsForScene(scene: LocalSceneState): LocalAdjustOptions {
  return normalizeLocalAdjustOptions({
    effect: scene.effect,
    exposure: scene.exposure,
    contrast: scene.contrast,
    saturation: scene.saturation,
    temperature: scene.temperature,
    tint: scene.tint,
    whites: scene.whites,
    blacks: scene.blacks,
    dehaze: scene.dehaze,
    highlights: scene.highlights,
    shadows: scene.shadows,
    vibrance: scene.vibrance,
    clarity: scene.clarity,
    effectStrength: scene.effectStrength,
    toneRange: scene.toneRange,
    angle: scene.angle,
    hairShade: scene.hairShade,
    eyeShadowShade: scene.eyeShadowShade,
    eyebrowShade: scene.eyebrowShade,
    contourShade: scene.contourShade,
    highlightShade: scene.highlightShade,
    aegyoSalShade: scene.aegyoSalShade,
    eyelinerShade: scene.eyelinerShade,
    irisShade: scene.irisShade,
  })
}

function sceneFromLayer(layer: LocalLayer, width: number, height: number): LocalSceneState {
  const o = layer.options
  return {
    radius: defaultBrushRadius(width, height),
    maskFeather: layer.feather,
    mode: 'paint',
    exposure: o.exposure ?? 0,
    contrast: o.contrast ?? 0,
    saturation: o.saturation ?? 0,
    temperature: o.temperature ?? 0,
    tint: o.tint ?? 0,
    whites: o.whites ?? 0,
    blacks: o.blacks ?? 0,
    dehaze: o.dehaze ?? 0,
    highlights: o.highlights ?? 0,
    shadows: o.shadows ?? 0,
    vibrance: o.vibrance ?? 0,
    clarity: o.clarity ?? 0,
    effect: o.effect ?? 'tone',
    effectStrength: o.effectStrength ?? 60,
    toneRange: o.toneRange ?? 'midtones',
    angle: o.angle ?? 0,
    hairShade: o.hairShade ?? 'brown',
    eyeShadowShade: o.eyeShadowShade ?? 'earth',
    eyebrowShade: o.eyebrowShade ?? 'brown',
    contourShade: o.contourShade ?? 'cool',
    highlightShade: o.highlightShade ?? 'champagne',
    aegyoSalShade: o.aegyoSalShade ?? 'pearl',
    eyelinerShade: o.eyelinerShade ?? 'black',
    irisShade: o.irisShade ?? 'brown',
    maskKind: layer.luminance ? 'luminance' : layer.color ? 'color' : 'brush',
    gradient: DEFAULT_LINEAR_GRADIENT,
    colorTarget: layer.color?.target ?? null,
    colorConnected: layer.color?.connected === true,
    colorSeed: layer.color?.seed
      ? { x: layer.color.seed[0], y: layer.color.seed[1] }
      : null,
    colorTolerance: layer.color?.tolerance ?? 25,
    colorFeather: layer.color?.feather ?? 35,
    luminanceRange: layer.luminance?.range ?? 'highlights',
    luminanceWidth: layer.luminance?.width ?? 35,
    luminanceFeather: layer.luminance?.feather ?? 30,
    invert: layer.luminance?.invert ?? layer.color?.invert ?? false,
    edge: layer.luminance?.edge ?? layer.color?.edge ?? 0,
    opacity: layer.opacity ?? 100,
    colorPick: false,
    dirty: true,
  }
}

export function useLocal(deps: LocalDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [local, setLocal] = useState<LocalSceneState | null>(null)
  const localMaskRef = useRef<Uint8Array | null>(null)
  const [localizing, setLocalizing] = useState(false)
  const [autoSelecting, setAutoSelecting] = useState(false)
  /** 正在回改哪一层；null = 新画的一层。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loadingLayer, setLoadingLayer] = useState(false)
  const layerSeqRef = useRef(0)
  /** 按颜色选蒙版时缓存的缩放底图；滑杆连续改不用重读原图。 */
  const colorSourceRef = useRef<ColorSource | null>(null)
  const [maskRevision, setMaskRevision] = useState(0)
  const bumpMask = useCallback(() => setMaskRevision(v => v + 1), [])

  const openLocal = useCallback(() => {
    if (!image) return
    layerSeqRef.current++
    setEditingId(null)
    setLoadingLayer(false)
    localMaskRef.current = createMask(image.width, image.height)
    setLocal({
      radius: defaultBrushRadius(image.width, image.height),
      maskFeather: 0,
      mode: 'paint',
      exposure: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      whites: 0,
      blacks: 0,
      dehaze: 0,
      highlights: 0,
      shadows: 0,
      vibrance: 0,
      clarity: 0,
      effect: 'tone',
      effectStrength: 60,
      toneRange: 'midtones',
      angle: 0,
      hairShade: 'brown',
      eyeShadowShade: 'earth',
      eyebrowShade: 'brown',
      contourShade: 'cool',
      highlightShade: 'champagne',
      aegyoSalShade: 'pearl',
      eyelinerShade: 'black',
      irisShade: 'brown',
      maskKind: 'brush',
      gradient: DEFAULT_LINEAR_GRADIENT,
      colorTarget: null,
      colorConnected: false,
      colorSeed: null,
      colorTolerance: 25,
      colorFeather: 35,
      luminanceRange: 'highlights',
      luminanceWidth: 35,
      luminanceFeather: 30,
      invert: false,
      edge: 0,
      opacity: 100,
      colorPick: false,
      dirty: false,
    })
  }, [image])

  const closeLocal = useCallback(() => {
    layerSeqRef.current++
    localMaskRef.current = null
    colorSourceRef.current = null
    setLocal(null)
    setEditingId(null)
    setLoadingLayer(false)
  }, [])

  const cancelLocal = () => { closeLocal(); setTool(null) }

  const markMaskDirty = useCallback(() => {
    setLocal(r => (r && !r.dirty ? { ...r, dirty: true } : r))
  }, [])

  const commitLocal = useCallback(async () => {
    const scene = local
    const mask = localMaskRef.current
    if (!scene || !mask || !image) return
    if (!sceneChanged(scene)) return
    if (scene.opacity <= 0) return
    if (scene.maskKind === 'linear' || scene.maskKind === 'radial') {
      fillGradientMask(mask, image.width, image.height, scene.gradient)
      if (scene.invert) mask.set(invertMask(mask))
    }
    // 色彩范围的 edge 已经在 `applyColorMask` 里做过；其它蒙版在这里统一做。
    const edged = scene.maskKind !== 'color' && scene.maskKind !== 'luminance' && scene.edge
      ? adjustMaskEdge(mask, image.width, image.height, scene.edge)
      : mask
    const featherRadius = scene.maskKind === 'brush'
      ? Math.round(Math.min(image.width, image.height) * 0.12 * (scene.maskFeather / 100))
      : 0
    const appliedMask = featherRadius > 0
      ? featherMask(edged, image.width, image.height, featherRadius)
      : edged
    const mixedMask = scene.opacity < 100
      ? scaleMask(appliedMask, scene.opacity)
      : appliedMask
    const bounds = maskBounds(mixedMask, image.width, image.height)
    if (!bounds) return
    const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
    // 色彩范围可能一口气选中整片天空：给它一档更宽的上限，仍然留「太大就拦」。
    // 保留颜色的蒙版通常是「除了主色以外」的大半张图，按背景虚化那一档放宽，
    // 否则一张普通手机照片就会被面积闸误伤。
    const colorSplash = scene.maskKind === 'color'
      && scene.invert && scene.saturation <= -99
    const maxPixels = colorSplash
      ? 12_000_000
      : scene.maskKind === 'color' || scene.maskKind === 'luminance'
        ? 4_000_000
        : MAX_LOCAL_PIXELS
    if (area > maxPixels) {
      noticeBad('这一块太大了，一次调一小块吧 —— 分几次调，又快又稳。')
      return
    }
    const slow = area > LOCAL_VEIL_PIXELS
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setLocalizing(slow)
    try {
      if (slow) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const opts: LocalAdjustOptions = scene.effect === 'tone'
        ? {
          effect: 'tone',
          exposure: scene.exposure,
          contrast: scene.contrast,
          saturation: scene.saturation,
          temperature: scene.temperature,
          tint: scene.tint,
          whites: scene.whites,
          blacks: scene.blacks,
          dehaze: scene.dehaze,
          highlights: scene.highlights,
          shadows: scene.shadows,
          vibrance: scene.vibrance,
          clarity: scene.clarity,
        }
        : scene.effect === 'motionBlur'
          ? {
            effect: 'motionBlur',
            effectStrength: scene.effectStrength,
            angle: scene.angle,
          }
          : scene.effect === 'hair'
          ? {
            effect: 'hair',
            effectStrength: scene.effectStrength,
            hairShade: scene.hairShade,
          }
          : scene.effect === 'dodge' || scene.effect === 'burn'
            ? {
              effect: scene.effect,
              effectStrength: scene.effectStrength,
              toneRange: scene.toneRange,
            }
          : scene.effect === 'eyeshadow'
            ? {
              effect: 'eyeshadow',
              effectStrength: scene.effectStrength,
              eyeShadowShade: scene.eyeShadowShade,
            }
            : scene.effect === 'eyebrow'
              ? {
                effect: 'eyebrow',
                effectStrength: scene.effectStrength,
                eyebrowShade: scene.eyebrowShade,
              }
              : scene.effect === 'contour'
                ? {
                  effect: 'contour',
                  effectStrength: scene.effectStrength,
                  contourShade: scene.contourShade,
                }
                : scene.effect === 'highlight'
                  ? {
                    effect: 'highlight',
                    effectStrength: scene.effectStrength,
                    highlightShade: scene.highlightShade,
                  }
                  : scene.effect === 'aegyoSal'
                    ? {
                      effect: 'aegyoSal',
                      effectStrength: scene.effectStrength,
                      aegyoSalShade: scene.aegyoSalShade,
                    }
                    : scene.effect === 'eyeliner'
                      ? {
                        effect: 'eyeliner',
                        effectStrength: scene.effectStrength,
                        eyelinerShade: scene.eyelinerShade,
                      }
                      : scene.effect === 'iris'
                        ? {
                          effect: 'iris',
                          effectStrength: scene.effectStrength,
                          irisShade: scene.irisShade,
                        }
                  : {
                    effect: scene.effect,
                    effectStrength: scene.effectStrength,
                  }
      const { bitmap } = await localAdjustToBitmap(image.bitmap, mixedMask, opts)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '局部调整回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '调的时候画面已经变了 —— 这一下没算数。要的话，再调一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一局部')
      }
      closeLocal()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的局部没调成。再试一次；还不行就换一张小一点的。')
    } finally {
      setLocalizing(false)
    }
  }, [local, image, history, noticeBad, closeLocal, flushEdit, clearTransient])

  /** 把当前现场存成**可回改**局部层：不换底图，只在 `layers` 里加 / 换一层。 */
  const saveLocalLayer = useCallback(async () => {
    const scene = local
    const mask = localMaskRef.current
    if (!scene || !mask || !image || loadingLayer) return
    if (!sceneChanged(scene)) return
    if (scene.opacity <= 0) return
    const existing = layers.filter(isLocalLayer)
    if (!editingId && existing.length >= LOCAL_LAYERS_MAX) {
      noticeBad(`一版最多存 ${LOCAL_LAYERS_MAX} 个可回改局部层；先删一个，或者点「应用局部」合进底图。`)
      return
    }
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setLocalizing(true)
    try {
      if (scene.maskKind === 'linear' || scene.maskKind === 'radial') {
        fillGradientMask(mask, image.width, image.height, scene.gradient)
        if (scene.invert) mask.set(invertMask(mask))
      }
      if (scene.maskKind !== 'color' && scene.maskKind !== 'luminance' && scene.edge) {
        mask.set(adjustMaskEdge(mask, image.width, image.height, scene.edge))
      }
      const encoded = await encodeMask(mask, image.width, image.height)
      if (baseSeqRef.current !== gate.seqAt || cursorIdRef.current !== gate.at) {
        noticeBad('存的时候画面已经变了 —— 这个局部层没算数。要的话，重新画一次。')
        return
      }
      const previous = editingId ? layers.find(l => l.id === editingId) : undefined
      const layer: LocalLayer = {
        kind: 'local',
        id: editingId
          ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        mask: encoded.mask,
        maskWidth: encoded.maskWidth,
        maskHeight: encoded.maskHeight,
        feather: scene.maskFeather,
        opacity: scene.opacity,
        options: optionsForScene(scene),
        ...(previous?.visible === false ? { visible: false } : {}),
        ...(scene.maskKind === 'color' && scene.colorTarget ? {
          color: {
            target: scene.colorTarget,
            tolerance: scene.colorTolerance,
            feather: scene.colorFeather,
            ...(scene.invert ? { invert: true } : {}),
            ...(scene.edge ? { edge: scene.edge } : {}),
            ...(scene.colorConnected ? { connected: true } : {}),
            ...(scene.colorConnected && scene.colorSeed
              ? { seed: [scene.colorSeed.x, scene.colorSeed.y] as const }
              : {}),
          },
        } : {}),
        ...(scene.maskKind === 'luminance' ? {
          luminance: {
            range: scene.luminanceRange,
            width: scene.luminanceWidth,
            feather: scene.luminanceFeather,
            ...(scene.invert ? { invert: true } : {}),
            ...(scene.edge ? { edge: scene.edge } : {}),
          },
        } : {}),
      }
      if (isNoopLocalOptions(layer.options)) return
      const keptChars = existing
        .filter(l => l.id !== editingId)
        .reduce((sum, l) => sum + l.mask.length, 0)
      if (keptChars + layer.mask.length > LOCAL_MASKS_TOTAL_MAX) {
        noticeBad('这一版的局部层占的空间太大了；先删掉一两层，或者把其中一层「应用局部」合进底图。')
        return
      }
      const next = editingId
        ? layers.map(l => (isLocalLayer(l) && l.id === editingId ? layer : l))
        : [...layers, layer]
      applyLayersEdit({
        at: gate.at, history, setHistory, editSeqRef, markDirty, flushEdit,
      }, next, '局部层')
      setLayers(next)
      closeLocal()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这个局部层没存下来。再试一次；还不行就先点「应用局部」合进底图。')
    } finally {
      setLocalizing(false)
    }
  }, [
    local, image, loadingLayer, layers, editingId, history, setHistory, editSeqRef,
    markDirty, flushEdit, noticeBad, setLayers, closeLocal, setTool,
  ])

  /** 点已有的局部层：把它的掩码和参数接回现场，之后可以改掩码或改值。 */
  const openLocalLayer = useCallback(async (id: string) => {
    if (!image) return
    const layer = layers.find((l): l is LocalLayer => isLocalLayer(l) && l.id === id)
    if (!layer) return
    const seq = ++layerSeqRef.current
    const at = cursorIdRef.current
    setLoadingLayer(true)
    try {
      await preloadLocalMasks([layer])
      const mask = await decodeMask(layer, image.width, image.height)
      if (seq !== layerSeqRef.current || cursorIdRef.current !== at) return
      localMaskRef.current = mask
      if (layer.color) colorSourceRef.current = prepareColorSource(image.bitmap)
      if (layer.luminance) colorSourceRef.current = prepareLuminanceSource(image.bitmap)
      setLocal(sceneFromLayer(layer, image.width, image.height))
      setEditingId(id)
      bumpMask()
    } catch (e) {
      console.error(e)
      noticeBad('这个局部层没打开。再试一次；还不行就删了重画。')
    } finally {
      if (seq === layerSeqRef.current) setLoadingLayer(false)
    }
  }, [image, layers, cursorIdRef, bumpMask, noticeBad])

  /** 删一层也记一笔，能撤销。 */
  const deleteLocalLayer = useCallback((id: string) => {
    if (!layers.some(l => isLocalLayer(l) && l.id === id)) return
    const next = layers.filter(l => !(isLocalLayer(l) && l.id === id))
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '局部层')
    setLayers(next)
    if (editingId === id) setEditingId(null)
  }, [
    layers, editingId, cursorIdRef, history, setHistory, editSeqRef, markDirty,
    flushEdit, setLayers,
  ])

  /** 按颜色选蒙版：缓存缩放底图，滑杆连续改时只重算蒙版。 */
  const applyColorMask = useCallback((
    target: Rgb, tolerance: number, feather: number, invert = false, edge = 0,
    connected = false, seed: { x: number; y: number } | null = null,
  ) => {
    const src = colorSourceRef.current
    const mask = localMaskRef.current
    if (!src || !mask || !image) return
    try {
      let next = maskFromColorSource(
        src, target, {
          tolerance, feather, connected,
          ...(seed ? { seedX: seed.x, seedY: seed.y } : {}),
        }, image.width, image.height,
      )
      if (invert) next = invertMask(next)
      if (edge) next = adjustMaskEdge(next, image.width, image.height, edge)
      if (next.length === mask.length) mask.set(next)
      else localMaskRef.current = next
      bumpMask()
    } catch (e) {
      console.error(e)
      noticeBad('这个颜色范围没算出来。再点一次颜色，或者把容差调小一点。')
    }
  }, [image, bumpMask, noticeBad])

  /** 按亮度生成蒙版；和色彩范围共用缩放像素缓存。 */
  const applyLuminanceMask = useCallback((
    range: ToneRange, widthSetting: number, feather: number, invert = false, edge = 0,
  ) => {
    const src = colorSourceRef.current
    const mask = localMaskRef.current
    if (!src || !mask || !image) return
    try {
      let next = maskFromLuminanceSource(src, {
        range, width: widthSetting, feather,
      }, image.width, image.height)
      if (invert) next = invertMask(next)
      if (edge) next = adjustMaskEdge(next, image.width, image.height, edge)
      if (next.length === mask.length) mask.set(next)
      else localMaskRef.current = next
      bumpMask()
    } catch (e) {
      console.error(e)
      noticeBad('这个明暗范围没算出来。再试一次，或者把范围调小一点。')
    }
  }, [image, bumpMask, noticeBad])

  const startColorPick = useCallback(() => {
    setLocal(r => (r ? { ...r, colorPick: true } : r))
  }, [])

  const setColorConnected = useCallback((on: boolean) => {
    setLocal(r => (r ? { ...r, colorConnected: on, dirty: true } : r))
    if (local?.colorTarget) {
      applyColorMask(
        local.colorTarget, local.colorTolerance, local.colorFeather,
        local.invert, local.edge, on, local.colorSeed,
      )
    }
  }, [local, applyColorMask])

  /**
   * 一键「保留颜色」：把色彩范围切成反选，并把局部饱和度压到 -100。
   * 用户接下来点照片里要保留的那个颜色，掩码就选中其余区域，只有那块被去色。
   * 容差 / 羽化 / 扩边仍可继续调；整条路复用现有色彩范围和局部引擎。
   */
  const startColorSplash = useCallback(() => {
    const mask = localMaskRef.current
    if (!image || !mask) return
    mask.fill(0)
    bumpMask()
    setLocal(r => (r ? {
      ...r,
      maskKind: 'color',
      effect: 'tone',
      colorTarget: null,
      colorConnected: false,
      colorSeed: null,
      colorPick: true,
      colorTolerance: 25,
      colorFeather: 35,
      invert: true,
      edge: 0,
      opacity: 100,
      exposure: 0,
      contrast: 0,
      saturation: -100,
      temperature: 0,
      tint: 0,
      whites: 0,
      blacks: 0,
      dehaze: 0,
      highlights: 0,
      shadows: 0,
      vibrance: 0,
      clarity: 0,
      dirty: false,
    } : r))
  }, [image, bumpMask])

  const sampleColorAt = useCallback((nx: number, ny: number) => {
    const scene = local
    if (!scene || !image || scene.maskKind !== 'color') return
    try {
      const src = colorSourceRef.current ?? prepareColorSource(image.bitmap)
      colorSourceRef.current = src
      const target = sampleColorSource(src, nx, ny)
      const spread = Math.max(target[0], target[1], target[2])
        - Math.min(target[0], target[1], target[2])
      if (scene.invert && scene.saturation <= -99 && spread < 20) {
        noticeBad('这个颜色太灰了，保留颜色需要点一块有颜色的地方。')
        return
      }
      let next = maskFromColorSource(src, target, {
        tolerance: scene.colorTolerance,
        feather: scene.colorFeather,
        connected: scene.colorConnected,
        seedX: nx,
        seedY: ny,
      }, image.width, image.height)
      if (scene.invert) next = invertMask(next)
      if (scene.edge) next = adjustMaskEdge(next, image.width, image.height, scene.edge)
      localMaskRef.current = next
      setLocal(r => (r ? {
        ...r,
        colorTarget: target,
        colorSeed: { x: nx, y: ny },
        colorPick: false,
        dirty: true,
      } : r))
      bumpMask()
    } catch (e) {
      console.error(e)
      noticeBad('这个颜色没取到。再点一下画面上的颜色试试。')
    }
  }, [local, image, bumpMask, noticeBad])

  const setColorTolerance = useCallback((v: number) => {
    setLocal(r => (r ? { ...r, colorTolerance: v } : r))
    if (local?.colorTarget) {
      applyColorMask(
        local.colorTarget, v, local.colorFeather, local.invert, local.edge,
        local.colorConnected, local.colorSeed,
      )
    }
  }, [local, applyColorMask])

  const setColorFeather = useCallback((v: number) => {
    setLocal(r => (r ? { ...r, colorFeather: v } : r))
    if (local?.colorTarget) {
      applyColorMask(
        local.colorTarget, local.colorTolerance, v, local.invert, local.edge,
        local.colorConnected, local.colorSeed,
      )
    }
  }, [local, applyColorMask])

  const setMaskEdge = useCallback((v: number) => {
    setLocal(r => (r ? { ...r, edge: v } : r))
    if (local?.colorTarget) {
      applyColorMask(
        local.colorTarget, local.colorTolerance, local.colorFeather, local.invert, v,
        local.colorConnected, local.colorSeed,
      )
    }
    if (local?.maskKind === 'luminance') {
      applyLuminanceMask(
        local.luminanceRange, local.luminanceWidth, local.luminanceFeather,
        local.invert, v,
      )
    }
  }, [local, applyColorMask, applyLuminanceMask])

  const setLuminanceRange = useCallback((range: ToneRange) => {
    setLocal(r => (r ? { ...r, luminanceRange: range, dirty: true } : r))
    if (local?.maskKind === 'luminance') {
      applyLuminanceMask(
        range, local.luminanceWidth, local.luminanceFeather, local.invert, local.edge,
      )
    }
  }, [local, applyLuminanceMask])

  const setLuminanceWidth = useCallback((v: number) => {
    setLocal(r => (r ? { ...r, luminanceWidth: v, dirty: true } : r))
    if (local?.maskKind === 'luminance') {
      applyLuminanceMask(
        local.luminanceRange, v, local.luminanceFeather, local.invert, local.edge,
      )
    }
  }, [local, applyLuminanceMask])

  const setLuminanceFeather = useCallback((v: number) => {
    setLocal(r => (r ? { ...r, luminanceFeather: v, dirty: true } : r))
    if (local?.maskKind === 'luminance') {
      applyLuminanceMask(
        local.luminanceRange, local.luminanceWidth, v, local.invert, local.edge,
      )
    }
  }, [local, applyLuminanceMask])

  /**
   * 反选。涂抹直接在掩码上翻（和原来一样）；渐变 / 色彩范围记一个 `invert`，
   * 每次重新生成蒙版时再翻 —— 否则调一下容差 / 羽化就会把反选冲掉。
   */
  const invertSelection = useCallback(() => {
    const scene = local
    const mask = localMaskRef.current
    if (!scene || !mask) return
    if (scene.maskKind === 'brush') {
      localMaskRef.current = invertMask(mask)
      setLocal(r => (r ? { ...r, dirty: true } : r))
      bumpMask()
      return
    }
    const next = !scene.invert
    setLocal(r => (r ? { ...r, invert: next, dirty: true } : r))
    if (scene.maskKind === 'color' && scene.colorTarget) {
      applyColorMask(
        scene.colorTarget, scene.colorTolerance, scene.colorFeather, next, scene.edge,
        scene.colorConnected, scene.colorSeed,
      )
    }
    if (scene.maskKind === 'luminance') {
      applyLuminanceMask(
        scene.luminanceRange, scene.luminanceWidth, scene.luminanceFeather,
        next, scene.edge,
      )
    }
    // 渐变：蒙版在提交时重新生成，`commitLocal` 会按这个标志翻。
  }, [local, applyColorMask, applyLuminanceMask, bumpMask])

  const setMaskKind = useCallback((
    maskKind: 'brush' | GradientKind | 'color' | 'luminance',
  ) => {
    const mask = localMaskRef.current
    if (!image || !mask) return
    mask.fill(0)
    bumpMask()
    if (maskKind === 'color') {
      setLocal(r => (r ? {
        ...r, maskKind, colorTarget: null, colorConnected: false, colorSeed: null,
        colorPick: false, invert: false, edge: 0, dirty: false,
      } : r))
      return
    }
    if (maskKind === 'brush') {
      setLocal(r => (r ? { ...r, maskKind, invert: false, edge: 0, dirty: false } : r))
      return
    }
    if (maskKind === 'luminance') {
      const range: ToneRange = 'highlights'
      const widthSetting = 35
      const feather = 30
      colorSourceRef.current ??= prepareLuminanceSource(image.bitmap)
      setLocal(r => (r ? {
        ...r,
        maskKind,
        luminanceRange: range,
        luminanceWidth: widthSetting,
        luminanceFeather: feather,
        colorTarget: null,
        colorConnected: false,
        colorSeed: null,
        colorPick: false,
        invert: false,
        edge: 0,
        dirty: true,
      } : r))
      applyLuminanceMask(range, widthSetting, feather)
      return
    }
    const gradient = maskKind === 'linear'
      ? { ...DEFAULT_LINEAR_GRADIENT }
      : { ...DEFAULT_RADIAL_GRADIENT }
    setLocal(r => (r ? { ...r, maskKind, gradient, invert: false, edge: 0, dirty: true } : r))
  }, [image, bumpMask, applyLuminanceMask])

  const changeGradient = useCallback((gradient: GradientSpec) => {
    setLocal(r => (r ? { ...r, gradient, dirty: true } : r))
  }, [])

  /**
   * 自动眼 / 自动牙 / 自动眼下：先用本地正脸框估计眼睛、嘴或眼下位置，再把选区写进当前
   * 局部掩码。用户仍可画笔补涂、橡皮修回，最后走同一条「应用局部」。
   */
  const autoSelectPart = useCallback(async (part: 'eyes' | 'teeth' | 'undereye') => {
    const mask = localMaskRef.current
    if (!image || !mask || autoSelecting) return
    setAutoSelecting(true)
    try {
      const face = await detectFaceInBitmap(image.bitmap)
      if (!face) {
        noticeBad('没找到正脸。自动选区需要一张脸更正、更清楚的照片；也可以直接用手动画笔涂。')
        return
      }
      const result = await selectFacePartToMask(image.bitmap, face, part, mask)
      if (result.covered === 0) {
        mask.fill(0)
        bumpMask()
        noticeBad(part === 'teeth'
          ? '没找到明显露出的牙齿。让牙齿露出来，或者直接用手动画笔涂。'
          : part === 'undereye'
            ? '没找到眼下区域。换一张更正的正脸，或者直接用手动画笔涂。'
            : '没找到眼睛区域。换一张更正的正脸，或者直接用手动画笔涂。')
        return
      }
      bumpMask()
      setLocal(r => (r ? {
        ...r,
        maskKind: 'brush',
        effect: part === 'eyes' ? 'eyes' : part === 'teeth' ? 'teeth' : 'darkcircle',
        dirty: true,
      } : r))
    } catch (e) {
      console.error(e)
      noticeBad('这次没认出眼睛 / 牙齿 / 眼下。再试一次；还不行就用手动画笔涂。')
    } finally {
      setAutoSelecting(false)
    }
  }, [image, autoSelecting, noticeBad, bumpMask])

  const autoSelectEyes = useCallback(() => { void autoSelectPart('eyes') }, [autoSelectPart])
  const autoSelectTeeth = useCallback(() => { void autoSelectPart('teeth') }, [autoSelectPart])
  const autoSelectUnderEye = useCallback(() => { void autoSelectPart('undereye') }, [autoSelectPart])

  /**
   * 自动主体 / 自动背景 / 自动天空：复用本地前景估计和天空颜色蒙版。
   * 写进的是当前局部掩码，用户仍可用画笔 / 橡皮修边。
   */
  const autoSelectSubject = useCallback(async (kind: 'subject' | 'background') => {
    const mask = localMaskRef.current
    if (!image || !mask || autoSelecting) return
    setAutoSelecting(true)
    try {
      const result = await selectSubjectToMask(image.bitmap, mask)
      if (result.subjectRatio < 0.02 || result.subjectRatio > 0.95) {
        mask.fill(0)
        bumpMask()
        noticeBad(kind === 'subject'
          ? '没认出主体。换一张主体更清楚的照片，或者直接用手动画笔涂。'
          : '这张的主体和背景分不开。换一张背景更干净的照片，或者直接用手动画笔涂。')
        return
      }
      if (kind === 'subject') localMaskRef.current = invertMask(mask)
      bumpMask()
      setLocal(r => (r ? {
        ...r, maskKind: 'brush', effect: 'tone', maskFeather: 8, dirty: true,
      } : r))
    } catch (e) {
      console.error(e)
      noticeBad('这次没认出主体 / 背景。再试一次；还不行就用手动画笔涂。')
    } finally {
      setAutoSelecting(false)
    }
  }, [image, autoSelecting, noticeBad, bumpMask])

  const autoSelectSky = useCallback(async () => {
    const mask = localMaskRef.current
    if (!image || !mask || autoSelecting) return
    setAutoSelecting(true)
    try {
      const result = await selectSkyToMask(image.bitmap, mask)
      if (result.covered === 0 || result.ratio > 0.8) {
        mask.fill(0)
        bumpMask()
        noticeBad('没找到明确的天空。换一张天空更完整的照片，或者直接用手动画笔涂。')
        return
      }
      bumpMask()
      setLocal(r => (r ? {
        ...r, maskKind: 'brush', effect: 'tone', maskFeather: 10, dirty: true,
      } : r))
    } catch (e) {
      console.error(e)
      noticeBad('这次没认出天空。再试一次；还不行就用手动画笔涂。')
    } finally {
      setAutoSelecting(false)
    }
  }, [image, autoSelecting, noticeBad, bumpMask])

  /**
   * 一键人像背景虚化：本机估主体 → 取背景蒙版 → 羽化 → 只虚化背景。
   * 不换工具、不生成；应用后走同一本账，可以撤销。
   */
  const blurBackground = useCallback(async () => {
    const mask = localMaskRef.current
    if (!image || !mask || !local || autoSelecting || localizing) return
    setAutoSelecting(true)
    setLocalizing(true)
    try {
      const result = await selectSubjectToMask(image.bitmap, mask)
      if (result.subjectRatio < 0.03 || result.subjectRatio > 0.95) {
        mask.fill(0)
        bumpMask()
        noticeBad('没认出主体。换一张主体更清楚、背景更干净的照片，或者用画笔手动涂背景。')
        return
      }
      bumpMask()
      const feather = Math.max(2, Math.round(Math.min(image.width, image.height) * 0.015))
      const soft = featherMask(mask, image.width, image.height, feather)
      const bounds = maskBounds(soft, image.width, image.height)
      if (!bounds) {
        noticeBad('背景区域太小，没地方虚化。换一张主体没占满画面的照片。')
        return
      }
      const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
      // 一键动作允许比手涂更大的一块；再大就明确拦住，不让主线程长时间卡住。
      if (area > 12_000_000) {
        noticeBad('这张照片的背景太大了，一键虚化会很久。先缩小照片，或者用画笔分几次做。')
        return
      }
      if (area > LOCAL_VEIL_PIXELS) {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      }
      const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
      const { bitmap } = await localAdjustToBitmap(image.bitmap, soft, {
        effect: 'blur',
        effectStrength: 65,
      })
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '背景虚化回来时底图/位置已经变了，这一下不写进去',
        notice: '虚化的时候画面已经变了 —— 这一下没算数。要的话，再点一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '背景虚化')
      }
      closeLocal()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('背景虚化没做成。再试一次；还不行就换一张小一点的照片。')
    } finally {
      setAutoSelecting(false)
      setLocalizing(false)
    }
  }, [
    image, local, autoSelecting, localizing, bumpMask, noticeBad, history, setHistory,
    setImage, baseSeqRef, cursorIdRef, editSeqRef, markDirty, flushEdit, clearTransient,
    closeLocal, setTool,
  ])

  const localScene: RetouchScene | null = (() => {
    const mask = localMaskRef.current
    if (!image || !local || tool !== 'local' || !mask) return null
    // 颜色范围：只把蒙版画出来给用户看，不接涂抹手势（点画面 = 取色）。
    if (local.maskKind === 'color' || local.maskKind === 'luminance') {
      return {
        radius: local.radius, mode: 'paint', mask,
        onMaskChange: () => {}, revision: maskRevision, readOnly: true,
      }
    }
    if (local.maskKind !== 'brush') return null
    return {
      radius: local.radius, mode: local.mode, mask,
      onMaskChange: markMaskDirty, revision: maskRevision,
    }
  })()

  const gradientScene: GradientScene | null = (() => {
    if (!image || !local || tool !== 'local'
      || (local.maskKind !== 'linear' && local.maskKind !== 'radial')) return null
    return { spec: local.gradient, onChange: changeGradient }
  })()

  return {
    local, setLocal, localizing, autoSelecting, openLocal, closeLocal,
    cancelLocal, markMaskDirty, commitLocal, setMaskKind, changeGradient,
    invertSelection, autoSelectEyes, autoSelectTeeth, autoSelectUnderEye, localScene, gradientScene,
    autoSelectSubject, autoSelectSky, blurBackground,
    editingId, loadingLayer, saveLocalLayer, openLocalLayer, deleteLocalLayer,
    startColorPick, startColorSplash, sampleColorAt, setColorConnected,
    setColorTolerance, setColorFeather, setMaskEdge,
    setLuminanceRange, setLuminanceWidth, setLuminanceFeather,
  }
}
