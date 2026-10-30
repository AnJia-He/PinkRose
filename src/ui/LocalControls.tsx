import { useLayoutEffect, useRef } from 'react'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius, type BrushMode } from '../core/retouch'
import {
  AEGYO_SAL_SHADES, CONTOUR_SHADES, EYELINER_SHADES, EYE_SHADOW_SHADES,
  EYEBROW_SHADES, HAIR_SHADES, HIGHLIGHT_SHADES, IRIS_SHADES,
  type AegyoSalShadeId, type ContourShadeId, type EyelinerShadeId,
  type EyeShadowShadeId, type EyebrowShadeId, type HairShadeId,
  type HighlightShadeId, type IrisShadeId, type LocalEffect, type ToneRange,
} from '../image/localAdjust'
import type { GradientKind, GradientSpec } from '../core/gradientMask'

type MaskKind = 'brush' | GradientKind | 'color' | 'luminance'

/**
 * 局部的第二行（★ 2026-10-17）—— 调色 / 牙齿 / 亮眼 / 红眼 / 发色 / 眼影 / 眉毛 / 祛皱 / 黑眼圈 / 动感模糊、
 * 涂抹 / 线性 / 径向（画笔蒙版还可以一键「反选」）、
 * 画笔 / 橡皮 / 笔刷或羽化、当前效果滑杆、取消 / 「应用局部」。
 *
 * 调色滑杆和牙齿 / 亮眼 / 祛皱的强度都是**局部**的：只影响涂出来的掩码，不写进
 * 全局 `params`。应用后作为当前这一版底图的一笔账；面板上的全局滑块不会被它改动。
 */
const MODES: [BrushMode, string][] = [['paint', '画笔'], ['erase', '橡皮']]
const EFFECTS: [LocalEffect, string][] = [
  ['tone', '调色'], ['teeth', '牙齿'], ['eyes', '亮眼'], ['redeye', '红眼'],
  ['hair', '发色'], ['eyeshadow', '眼影'], ['eyebrow', '眉毛'],
  ['contour', '修容'], ['highlight', '高光'],
  ['iris', '美瞳'],
  ['aegyoSal', '卧蚕'], ['eyeliner', '眼线'],
  ['wrinkle', '祛皱'], ['darkcircle', '黑眼圈'],
  ['antiglare', '去反光'], ['dodge', '减淡'], ['burn', '加深'],
  ['blur', '模糊'], ['motionBlur', '动感模糊'],
  ['mosaic', '马赛克'],
]
const TONE_RANGES: [ToneRange, string][] = [
  ['shadows', '阴影'], ['midtones', '中间调'], ['highlights', '高光'],
]
const MASK_KINDS: [MaskKind, string][] = [
  ['brush', '涂抹'], ['linear', '线性'], ['radial', '径向'],
  ['color', '色彩范围'], ['luminance', '明暗'],
]

type Props = {
  image: { width: number; height: number }
  mode: BrushMode
  radius: number
  maskFeather: number
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
  /** 动感模糊方向：0 = 水平、90 = 垂直，0~360 度。 */
  angle: number
  hairShade: HairShadeId
  eyeShadowShade: EyeShadowShadeId
  eyebrowShade: EyebrowShadeId
  contourShade: ContourShadeId
  highlightShade: HighlightShadeId
  aegyoSalShade: AegyoSalShadeId
  eyelinerShade: EyelinerShadeId
  irisShade: IrisShadeId
  maskKind: MaskKind
  gradient: GradientSpec
  colorTarget: readonly [number, number, number] | null
  colorPick: boolean
  colorConnected: boolean
  colorTolerance: number
  colorFeather: number
  luminanceRange: ToneRange
  luminanceWidth: number
  luminanceFeather: number
  /** 渐变 / 色彩范围的反选状态（涂抹是直接翻掩码，不显示这个开关）。 */
  invert: boolean
  /** 蒙版扩展 / 收缩（图片像素，正数外扩、负数内收）。 */
  edge: number
  /** 整层不透明度 0–100。 */
  opacity: number
  dirty: boolean
  localizing: boolean
  autoSelecting: boolean
  /** 当前这一版已经存下的可回改局部层（按层序）。 */
  localLayers: readonly { id: string }[]
  /** 正在回改哪一层；null = 新的一层。 */
  editingId: string | null
  loadingLayer: boolean
  onMode: (mode: BrushMode) => void
  onRadius: (radius: number) => void
  onMaskFeather: (v: number) => void
  onExposure: (v: number) => void
  onContrast: (v: number) => void
  onSaturation: (v: number) => void
  onTemperature: (v: number) => void
  onTint: (v: number) => void
  onWhites: (v: number) => void
  onBlacks: (v: number) => void
  onDehaze: (v: number) => void
  onHighlights: (v: number) => void
  onShadows: (v: number) => void
  onVibrance: (v: number) => void
  onClarity: (v: number) => void
  onEffect: (effect: LocalEffect) => void
  onEffectStrength: (v: number) => void
  onToneRange: (range: ToneRange) => void
  onAngle: (v: number) => void
  onHairShade: (id: HairShadeId) => void
  onEyeShadowShade: (id: EyeShadowShadeId) => void
  onEyebrowShade: (id: EyebrowShadeId) => void
  onContourShade: (id: ContourShadeId) => void
  onHighlightShade: (id: HighlightShadeId) => void
  onAegyoSalShade: (id: AegyoSalShadeId) => void
  onEyelinerShade: (id: EyelinerShadeId) => void
  onIrisShade: (id: IrisShadeId) => void
  onAutoEyes: () => void
  onAutoTeeth: () => void
  onAutoUnderEye: () => void
  onAutoSubject: () => void
  onAutoBackground: () => void
  onAutoSky: () => void
  onBlurBackground: () => void
  /** 一键保留颜色：切到反选色彩范围 + 饱和度 -100，再等用户点颜色。 */
  onColorSplash: () => void
  onMaskKind: (kind: MaskKind) => void
  onInvertMask: () => void
  onGradientFeather: (v: number) => void
  onStartColorPick: () => void
  onColorConnected: (on: boolean) => void
  onColorTolerance: (v: number) => void
  onColorFeather: (v: number) => void
  onLuminanceRange: (range: ToneRange) => void
  onLuminanceWidth: (v: number) => void
  onLuminanceFeather: (v: number) => void
  onMaskEdge: (v: number) => void
  onOpacity: (v: number) => void
  onLiquify: () => void
  onEditLayer: (id: string) => void
  onDeleteLayer: (id: string) => void
  onSaveLayer: () => void
  onCancel: () => void
  onDone: () => void
}

export default function LocalControls({
  image, mode, radius, maskFeather, exposure, contrast, saturation, temperature, tint,
  whites, blacks, dehaze,
  highlights, shadows, vibrance, clarity,
  effect, effectStrength, toneRange, angle, hairShade, eyeShadowShade, eyebrowShade,
  contourShade, highlightShade, aegyoSalShade, eyelinerShade, irisShade,
  maskKind, gradient, colorTarget, colorPick, colorConnected, colorTolerance, colorFeather,
  luminanceRange, luminanceWidth, luminanceFeather, invert, edge,
  opacity,
  dirty, localizing,
  autoSelecting, localLayers, editingId, loadingLayer,
  onMode, onRadius, onMaskFeather, onExposure, onContrast, onSaturation, onTemperature, onTint,
  onWhites, onBlacks, onDehaze,
  onHighlights, onShadows, onVibrance, onClarity,
  onEffect, onEffectStrength, onToneRange, onAngle, onHairShade, onEyeShadowShade, onEyebrowShade,
  onContourShade, onHighlightShade, onAegyoSalShade, onEyelinerShade, onIrisShade,
  onAutoEyes, onAutoTeeth,
  onAutoUnderEye,
  onAutoSubject, onAutoBackground, onAutoSky,
  onBlurBackground,
  onColorSplash,
  onMaskKind, onGradientFeather, onStartColorPick, onColorConnected, onColorTolerance, onColorFeather,
  onLuminanceRange, onLuminanceWidth, onLuminanceFeather,
  onMaskEdge, onOpacity,
  onInvertMask,
  onLiquify, onEditLayer, onDeleteLayer, onSaveLayer, onCancel, onDone,
}: Props) {
  const rangeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (effect !== 'dodge' && effect !== 'burn') return
    const range = rangeRef.current
    const row = range?.closest<HTMLElement>('.tool-row-second')
    const scroller = range?.closest<HTMLElement>('.local-scroll') ?? row
    const actions = row?.querySelector<HTMLElement>('.crop-tools')
    if (!range || !row || !scroller || !actions) return
    // 在 layout effect 里直接量、直接滚：范围按钮是选择「减淡 / 加深」后才插入的，
    // 若等到下一帧，iPad WebKit 在高负载下可能先停下滚动、再让点击焦点把工具条
    // 拉回原位，结果按钮存在却不在可视区。这里强制同步布局后一次到位。
    const rowBox = scroller.getBoundingClientRect()
    const rangeBox = range.getBoundingClientRect()
    const actionsBox = actions.getBoundingClientRect()
    const leftLimit = rowBox.left + 8
    const rightLimit = Math.min(rowBox.right, actionsBox.left) - 8
    if (rangeBox.right > rightLimit) scroller.scrollLeft += rangeBox.right - rightLimit
    else if (rangeBox.left < leftLimit) scroller.scrollLeft -= leftLimit - rangeBox.left
  }, [effect])
  const changed = effect === 'tone'
    ? exposure !== 0 || contrast !== 0 || saturation !== 0 || temperature !== 0
      || tint !== 0
      || whites !== 0 || blacks !== 0
      || dehaze !== 0
      || highlights !== 0 || shadows !== 0
      || vibrance !== 0 || clarity !== 0
    : effectStrength > 0
  return (
    <>
      <div className="local-scroll">
      <div className="retouch-modes" role="group" aria-label="局部效果">
        {EFFECTS.map(([value, name]) => {
          const on = effect === value
          return (
            <button
              key={value} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onEffect(value)}
            >{name}</button>
          )
        })}
      </div>
      {(effect === 'dodge' || effect === 'burn') && (
        <div ref={rangeRef} className="retouch-modes" role="group" aria-label="明暗范围">
          {TONE_RANGES.map(([value, name]) => {
            const on = toneRange === value
            return (
              <button
                key={value} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onToneRange(value)}
              >{name}</button>
            )
          })}
        </div>
      )}
      <div className="retouch-modes" role="group" aria-label="自动选区">
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoSubject}>自动主体</button>
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoBackground}>自动背景</button>
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoSky}>自动天空</button>
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoEyes}>自动眼</button>
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoTeeth}>自动牙</button>
        <button type="button" className="crop-chip" disabled={autoSelecting}
          onClick={onAutoUnderEye}>自动眼下</button>
        <button type="button" className="crop-chip" disabled={autoSelecting || localizing}
          onClick={onBlurBackground}>一键虚化背景</button>
        <button
          type="button"
          className="crop-chip"
          title="点选要保留的颜色，其余区域变黑白"
          disabled={autoSelecting || localizing}
          onClick={onColorSplash}
        >保留颜色</button>
      </div>
      <div className="retouch-modes" role="group" aria-label="蒙版形状">
        {MASK_KINDS.map(([kind, name]) => {
          const on = maskKind === kind
          return (
            <button
              key={kind} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onMaskKind(kind)}
            >{name}</button>
          )
        })}
      </div>
      <button
        type="button"
        className={`crop-chip${maskKind !== 'brush' && invert ? ' on' : ''}`}
        aria-pressed={maskKind === 'brush' ? undefined : invert}
        onClick={onInvertMask}
      >反选</button>
      {maskKind === 'brush' && (
        <div className="retouch-modes" role="group" aria-label="笔触">
          {MODES.map(([m, name]) => {
            const on = mode === m
            return (
              <button
                key={m} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onMode(m)}
              >{name}</button>
            )
          })}
        </div>
      )}
      <button type="button" className="crop-chip" onClick={onLiquify}>液化</button>
      {maskKind === 'brush' && (
        <Slider
          label="笔刷" value={radius}
          min={4} max={maxBrushRadius(image.width, image.height)} step={1}
          changed={radius !== defaultBrushRadius(image.width, image.height)}
          onChange={onRadius}
        />
      )}
      {maskKind === 'brush' && (
        <Slider
          label="羽化" value={maskFeather} min={0} max={100} step={1}
          changed={maskFeather !== 0} onChange={onMaskFeather}
        />
      )}
      {maskKind === 'radial' && (
        <Slider
          label="羽化" value={Math.round(gradient.feather * 100)}
          min={0} max={100} step={1}
          changed={Math.round(gradient.feather * 100) !== 60}
          onChange={v => onGradientFeather(v / 100)}
        />
      )}
      {maskKind === 'color' && (
        <>
          <button
            type="button"
            className={`crop-chip${colorConnected ? ' on' : ''}`}
            aria-pressed={colorConnected}
            title="只选与点击位置相连的同色区域"
            onClick={() => onColorConnected(!colorConnected)}
          >相连区域</button>
          <button
            type="button"
            className={`crop-chip${colorPick ? ' on' : ''}`}
            aria-pressed={colorPick}
            onClick={onStartColorPick}
          >{colorPick ? '点照片上的颜色…' : colorTarget ? '重新点颜色' : '点选颜色'}</button>
          {colorTarget && (
            <span
              className="color-range-swatch"
              aria-label="已选颜色"
              style={{
                background: `rgb(${colorTarget[0]}, ${colorTarget[1]}, ${colorTarget[2]})`,
              }}
            />
          )}
          <Slider
            label="容差" value={colorTolerance} min={0} max={100} step={1}
            changed={colorTolerance !== 25} onChange={onColorTolerance}
          />
          <Slider
            label="羽化" value={colorFeather} min={0} max={100} step={1}
            changed={colorFeather !== 35} onChange={onColorFeather}
          />
        </>
      )}
      {maskKind === 'luminance' && (
        <>
          <div className="retouch-modes" role="group" aria-label="明暗范围">
            {TONE_RANGES.map(([value, name]) => {
              const on = luminanceRange === value
              return (
                <button
                  key={value} type="button"
                  className={`crop-chip${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onLuminanceRange(value)}
                >{name}</button>
              )
            })}
          </div>
          <Slider
            label="范围" value={luminanceWidth} min={0} max={100} step={1}
            changed={luminanceWidth !== 35} onChange={onLuminanceWidth}
          />
          <Slider
            label="羽化" value={luminanceFeather} min={0} max={100} step={1}
            changed={luminanceFeather !== 30} onChange={onLuminanceFeather}
          />
        </>
      )}
      <Slider
        label="扩边" value={edge} min={-50} max={50} step={1}
        changed={edge !== 0} onChange={onMaskEdge}
      />
      {effect === 'tone' ? (
        <>
          <Slider label="亮度" value={exposure} min={-100} max={100} step={1}
            changed={exposure !== 0} onChange={onExposure} />
          <Slider label="对比度" value={contrast} min={-100} max={100} step={1}
            changed={contrast !== 0} onChange={onContrast} />
          <Slider label="饱和度" value={saturation} min={-100} max={100} step={1}
            changed={saturation !== 0} onChange={onSaturation} />
          <Slider label="色温" value={temperature} min={-100} max={100} step={1}
            changed={temperature !== 0} onChange={onTemperature} />
          <Slider label="色调" value={tint} min={-100} max={100} step={1}
            changed={tint !== 0} onChange={onTint} />
          <Slider label="白色色阶" value={whites} min={-100} max={100} step={1}
            changed={whites !== 0} onChange={onWhites} />
          <Slider label="黑色色阶" value={blacks} min={-100} max={100} step={1}
            changed={blacks !== 0} onChange={onBlacks} />
          <Slider label="去雾" value={dehaze} min={-100} max={100} step={1}
            changed={dehaze !== 0} onChange={onDehaze} />
          <Slider label="高光" value={highlights} min={-100} max={100} step={1}
            changed={highlights !== 0} onChange={onHighlights} />
          <Slider label="阴影" value={shadows} min={-100} max={100} step={1}
            changed={shadows !== 0} onChange={onShadows} />
          <Slider label="自然饱和度" value={vibrance} min={-100} max={100} step={1}
            changed={vibrance !== 0} onChange={onVibrance} />
          <Slider label="清晰度" value={clarity} min={-100} max={100} step={1}
            changed={clarity !== 0} onChange={onClarity} />
        </>
      ) : (
        <>
          <Slider label="强度" value={effectStrength} min={0} max={100} step={1}
            changed={effectStrength !== 60} onChange={onEffectStrength} />
          {effect === 'motionBlur' && (
            <Slider label="角度" value={angle} min={0} max={360} step={1}
              changed={angle !== 0} onChange={onAngle} />
          )}
        </>
      )}
      {effect === 'hair' && (
        <div className="retouch-modes" role="group" aria-label="发色">
          {HAIR_SHADES.map(s => {
            const on = hairShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onHairShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'eyeshadow' && (
        <div className="retouch-modes" role="group" aria-label="眼影色号">
          {EYE_SHADOW_SHADES.map(s => {
            const on = eyeShadowShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onEyeShadowShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'eyebrow' && (
        <div className="retouch-modes" role="group" aria-label="眉毛色号">
          {EYEBROW_SHADES.map(s => {
            const on = eyebrowShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onEyebrowShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'contour' && (
        <div className="retouch-modes" role="group" aria-label="修容色号">
          {CONTOUR_SHADES.map(s => {
            const on = contourShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onContourShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'highlight' && (
        <div className="retouch-modes" role="group" aria-label="高光色号">
          {HIGHLIGHT_SHADES.map(s => {
            const on = highlightShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onHighlightShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'iris' && (
        <div className="retouch-modes" role="group" aria-label="美瞳色号">
          {IRIS_SHADES.map(s => {
            const on = irisShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onIrisShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'aegyoSal' && (
        <div className="retouch-modes" role="group" aria-label="卧蚕色号">
          {AEGYO_SAL_SHADES.map(s => {
            const on = aegyoSalShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onAegyoSalShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      {effect === 'eyeliner' && (
        <div className="retouch-modes" role="group" aria-label="眼线色号">
          {EYELINER_SHADES.map(s => {
            const on = eyelinerShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onEyelinerShade(s.id)}
              >
                <span
                  className="makeup-dot"
                  style={{ background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})` }}
                  aria-hidden="true"
                />
                {s.label}
              </button>
            )
          })}
        </div>
      )}
      <Slider
        label="不透明度" value={opacity} min={0} max={100} step={1}
        changed={opacity !== 100} onChange={onOpacity}
      />
      {localLayers.length > 0 && (
        <div className="retouch-modes" role="group" aria-label="可回改局部层">
          {localLayers.map((layer, i) => (
            <span key={layer.id} className="local-layer-chip">
              <button
                type="button"
                className={`crop-chip${editingId === layer.id ? ' on' : ''}`}
                aria-pressed={editingId === layer.id}
                disabled={loadingLayer}
                onClick={() => onEditLayer(layer.id)}
              >局部层 {i + 1}</button>
              <button
                type="button"
                className="crop-chip local-layer-del"
                aria-label={`删除局部层 ${i + 1}`}
                disabled={loadingLayer}
                onClick={() => onDeleteLayer(layer.id)}
              >删</button>
            </span>
          ))}
        </div>
      )}
      </div>
      <div className="crop-tools">
        <button
          type="button" className="crop-btn"
          disabled={!dirty || localizing || loadingLayer || !changed || opacity <= 0}
          onClick={onSaveLayer}
        >{editingId ? '更新层' : '存为层'}</button>
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || localizing || loadingLayer || !changed || opacity <= 0}
          onClick={() => void onDone()}
        >应用局部</Btn>
      </div>
    </>
  )
}
