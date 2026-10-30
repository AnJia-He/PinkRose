import { Btn } from './kit/Btn.tsx'

/** 四角透视第二行（★ 2026-10-17）—— 拖照片上的四个角，再应用。 */
type Props = {
  applying: boolean
  dirty: boolean
  autoDetecting: boolean
  onAuto: () => void
  onBack: () => void
  onReset: () => void
  onCancel: () => void
  onDone: () => void
}

export default function PerspectiveControls({
  applying, dirty, autoDetecting, onAuto, onBack, onReset, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onBack}>裁剪</button>
      <span className="tool-note">自动找竖边，或拖四个角微调</span>
      <button
        type="button"
        className="crop-chip"
        disabled={autoDetecting || applying}
        onClick={onAuto}
      >{autoDetecting ? '识别中…' : '自动透视'}</button>
      <button type="button" className="crop-btn" disabled={!dirty} onClick={onReset}>重置</button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || applying}
          onClick={() => void onDone()}
        >应用透视</Btn>
      </div>
    </>
  )
}
