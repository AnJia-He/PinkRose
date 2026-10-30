import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { LIP_SHADES, type LipShadeId } from '../image/makeup'

/**
 * 「人像」工具第二行：瘦脸 / 大眼 / 瘦鼻 / 下巴 / 瘦颈 / 双下巴 / 瘦身 + 补光 + 口红 / 腮红 +
 * 重来 / 取消 / 应用人像。滑杆都是 0~100；0 = 不动。脸框由本地肤色估计，侧脸或小脸会提示
 * 改用「局部 → 液化」手动推。
 */
type Props = {
  detecting: boolean
  manualPicking: boolean
  faceCount: number
  faceIndex: number
  slim: number
  head: number
  crown: number
  eyes: number
  nose: number
  chin: number
  smile: number
  neck: number
  doubleChin: number
  shoulder: number
  body: number
  legs: number
  blemish: boolean
  blemishEmpty: boolean
  smooth: number
  light: number
  whiten: number
  rosy: number
  lip: number
  blush: number
  lipShade: LipShadeId
  dirty: boolean
  applying: boolean
  onManualFace: () => void
  onRetryAuto: () => void
  onFace: (index: number) => void
  onSlim: (v: number) => void
  onHead: (v: number) => void
  onCrown: (v: number) => void
  onEyes: (v: number) => void
  onNose: (v: number) => void
  onChin: (v: number) => void
  onSmile: (v: number) => void
  onNeck: (v: number) => void
  onDoubleChin: (v: number) => void
  onShoulder: (v: number) => void
  onBody: (v: number) => void
  onLegs: (v: number) => void
  onBlemish: () => void
  onSmooth: (v: number) => void
  onLight: (v: number) => void
  onWhiten: (v: number) => void
  onRosy: (v: number) => void
  onLip: (v: number) => void
  onBlush: (v: number) => void
  onLipShade: (id: LipShadeId) => void
  onAuto: () => void
  onReset: () => void
  onCancel: () => void
  onDone: () => void
}

export default function PortraitControls({
  detecting, manualPicking, faceCount, faceIndex,
  slim, head, crown, eyes, nose, chin, smile, neck, doubleChin, shoulder, body, legs, lip, blush, lipShade, dirty, applying,
  blemish, blemishEmpty, smooth, light, whiten, rosy,
  onManualFace, onRetryAuto,
  onFace, onSlim, onHead, onCrown, onEyes, onNose, onChin, onSmile, onNeck, onDoubleChin, onShoulder, onBody, onLegs, onBlemish,
  onSmooth, onLight, onWhiten, onRosy, onLip, onBlush, onLipShade,
  onAuto, onReset, onCancel, onDone,
}: Props) {
  if (manualPicking) {
    return (
      <>
        <span className="tool-note" aria-live="polite">
          自动找脸没成功。请在照片上拖一个脸框圈住正脸；框太小会忽略。
        </span>
        <div className="crop-tools">
          <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
          <button type="button" className="crop-btn" onClick={onRetryAuto}>再自动找</button>
        </div>
      </>
    )
  }
  return (
    <>
      <span className="tool-note" aria-live="polite">
        {detecting
          ? '正在找人脸…'
          : blemish && blemishEmpty
            ? '没找到明显的小斑点；可以用点修手动擦。'
            : faceCount > 1
              ? faceIndex === -1
                ? `找到 ${faceCount} 张脸；同一套参数会应用到全部脸，身体关系只做一次`
                : `找到 ${faceCount} 张脸；当前只改「脸 ${faceIndex + 1}」，磨皮也只作用在这张脸框内`
            : '按正脸估计；磨皮只作用在脸框内，一键美颜给补光、轻塑形和一点气色'}
      </span>
      {!detecting && faceCount > 1 && (
        <div className="retouch-modes" role="group" aria-label="选择人脸">
          <button
            type="button"
            className={`crop-chip${faceIndex === -1 ? ' on' : ''}`}
            aria-pressed={faceIndex === -1}
            onClick={() => onFace(-1)}
            disabled={applying}
          >全部</button>
          {Array.from({ length: faceCount }, (_, index) => {
            const on = faceIndex === index
            return (
              <button
                key={index}
                type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onFace(index)}
                disabled={applying}
              >脸 {index + 1}</button>
            )
          })}
        </div>
      )}
      <button
        type="button"
        className="crop-chip"
        onClick={onManualFace}
        disabled={detecting || applying}
      >重选脸</button>
      <button
        type="button"
        className="crop-chip"
        onClick={onAuto}
        disabled={detecting || applying}
      >一键美颜</button>
      <button
        type="button"
        className={`crop-chip${blemish ? ' on' : ''}`}
        aria-pressed={blemish}
        onClick={onBlemish}
        disabled={detecting || applying}
      >去斑</button>
      <Slider label="磨皮" value={smooth} min={0} max={100} step={1}
        changed={smooth !== 0} onChange={onSmooth} />
      <Slider label="瘦脸" value={slim} min={0} max={100} step={1}
        changed={slim !== 0} onChange={onSlim} />
      <Slider label="小头" value={head} min={0} max={100} step={1}
        changed={head !== 0} onChange={onHead} />
      <Slider label="颅顶" value={crown} min={0} max={100} step={1}
        changed={crown !== 0} onChange={onCrown} />
      <Slider label="大眼" value={eyes} min={0} max={100} step={1}
        changed={eyes !== 0} onChange={onEyes} />
      <Slider label="瘦鼻" value={nose} min={0} max={100} step={1}
        changed={nose !== 0} onChange={onNose} />
      <Slider label="下巴" value={chin} min={0} max={100} step={1}
        changed={chin !== 0} onChange={onChin} />
      <Slider label="微笑" value={smile} min={0} max={100} step={1}
        changed={smile !== 0} onChange={onSmile} />
      <Slider label="瘦颈" value={neck} min={0} max={100} step={1}
        changed={neck !== 0} onChange={onNeck} />
      <Slider label="双下巴" value={doubleChin} min={0} max={100} step={1}
        changed={doubleChin !== 0} onChange={onDoubleChin} />
      <Slider label="直角肩" value={shoulder} min={0} max={100} step={1}
        changed={shoulder !== 0} onChange={onShoulder} />
      <Slider label="瘦身" value={body} min={0} max={100} step={1}
        changed={body !== 0} onChange={onBody} />
      <Slider label="长腿" value={legs} min={0} max={100} step={1}
        changed={legs !== 0} onChange={onLegs} />
      <Slider label="补光" value={light} min={0} max={100} step={1}
        changed={light !== 0} onChange={onLight} />
      <Slider label="美白" value={whiten} min={0} max={100} step={1}
        changed={whiten !== 0} onChange={onWhiten} />
      <Slider label="红润" value={rosy} min={0} max={100} step={1}
        changed={rosy !== 0} onChange={onRosy} />
      <Slider label="口红" value={lip} min={0} max={100} step={1}
        changed={lip !== 0} onChange={onLip} />
      <Slider label="腮红" value={blush} min={0} max={100} step={1}
        changed={blush !== 0} onChange={onBlush} />
      {lip > 0 && (
        <div className="retouch-modes" role="group" aria-label="口红色号">
          {LIP_SHADES.map(s => {
            const on = lipShade === s.id
            return (
              <button
                key={s.id} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onLipShade(s.id)}
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
      <button type="button" className="crop-btn" onClick={onReset} disabled={!dirty}>
        重来
      </button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={detecting || !dirty || applying}
          onClick={() => void onDone()}
        >应用人像</Btn>
      </div>
    </>
  )
}
