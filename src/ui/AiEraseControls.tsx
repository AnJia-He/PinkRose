import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius, type BrushMode } from '../core/retouch'

/**
 * 「点修 → AI 消除」的第二次定稿。
 *
 * 和点修 / 磨皮同一套手：先涂，再按主按钮。唯一的区别是这次真的会花
 * 生成额度，所以这句话必须一直挂在现场，而不是只在按下之后才说。
 */
const MODES: [BrushMode, string][] = [['paint', '画笔'], ['erase', '橡皮']]

type Props = {
  image: { width: number; height: number }
  mode: BrushMode
  radius: number
  prompt: string
  dirty: boolean
  applying: boolean
  blocked: boolean
  onMode: (mode: BrushMode) => void
  onRadius: (radius: number) => void
  onPrompt: (prompt: string) => void
  onCancel: () => void
  onDone: () => void
}

export default function AiEraseControls({
  image, mode, radius, prompt, dirty, applying, blocked,
  onMode, onRadius, onPrompt, onCancel, onDone,
}: Props) {
  return (
    <>
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
      <Slider
        label="笔刷" value={radius}
        min={4} max={maxBrushRadius(image.width, image.height)} step={1}
        changed={radius !== defaultBrushRadius(image.width, image.height)}
        onChange={onRadius}
      />
      <input
        className="text-input ai-edit-input"
        value={prompt}
        maxLength={200}
        disabled={applying}
        placeholder="想改成什么？留空 = 消除"
        aria-label="AI 局部编辑指令"
        onChange={e => onPrompt(e.target.value)}
      />
      <span className="tool-note">会消耗生成额度</span>
      <div className="crop-tools">
        <button type="button" className="crop-btn" disabled={applying} onClick={onCancel}>
          取消
        </button>
        <Btn
          className="crop-done"
          disabled={!dirty || applying || blocked}
          onClick={() => void onDone()}
        >
          {applying ? '处理中…' : prompt.trim() ? 'AI 编辑' : 'AI 消除'}
        </Btn>
      </div>
    </>
  )
}
