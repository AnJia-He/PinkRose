import { useRef } from 'react'
import { Images } from 'lucide-react'
import { PARAM_KEYS, PARAM_LABELS, isChanged, type Adjustments, PARAM_MIN, PARAM_MAX } from '../../shared/adjustments.ts'
import { PRESETS } from '../core/presets'
import { Slider } from './kit/Slider.tsx'

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
  onReset: () => void
  /**
   * 用户挑了一张参考图，要"照着它调"。
   *
   * 面板只负责**把文件交出去**：采样和拟合都在 App 那边（本地、纯计算，
   * 见 `core/colorMatch.ts`）。面板是长相，不碰画布和像素 —— 那两层
   * 分开之后，"调色面板长什么样"和"怎么算出这组参数"才能各测各的。
   */
  onMatchReference: (file: File) => void
}

export default function AdjustmentPanel({ value, onChange, onReset, onMatchReference }: Props) {
  const set = (k: keyof Adjustments, v: number) => onChange({ ...value, [k]: v })
  const refInput = useRef<HTMLInputElement>(null)

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>调色</span>
        <button onClick={onReset}>重置</button>
      </div>

      <div className="presets">
        {PRESETS.map(p => (
          // 展开拷贝：PRESETS 是模块级共享对象，直接传引用会让拖滑块改坏预设
          <button key={p.id} onClick={() => onChange({ ...p.adjustments })}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 「照着这张调」**故意不摆进上面那一排**，两条理由：
          · 那排是"按一下立刻出结果"的药丸，而这一颗点了会先开文件选择器
            —— 混在一起，用户会以为按下去画面就该变；
          · 上面那条注释写着"一排六个不许换行成两排"，多一颗长的就破了。
          而它跟上排**是同一类东西**（产出一组参数），所以紧挨着它们。
          ⚠️ 用真的 `<button>` 而不是 `<label>` 包一个 input：全站那套按钮的长相
          （底色/边框/悬停/按下/禁用）都在 CSS 的 `button` 那条通用规则里，
          用 label 就得把那一整套抄一遍 —— 抄完就多一份会漂的长相。 */}
      <button className="presets-ref" onClick={() => refInput.current?.click()}>
        <Images size={14} strokeWidth={1.5} aria-hidden="true" />
        照着这张调
      </button>
      <input
        ref={refInput}
        className="presets-ref-file"
        type="file"
        accept="image/*"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onMatchReference(f)
          // 清空 value：同一张参考图连选两次也要能再触发一次 change
          e.target.value = ''
        }}
      />

      {/* 八条滑块**自己一层**，分栏只发生在这里；面板本身仍是"头 / 预设 / 滑块组"
          的竖列。
          ⚠️ 原来分栏直接写在 `.panel` 上，靠 CSS 里一份"谁横跨全宽"的类名清单
          （`.panel-head, .presets { grid-column: 1 / -1 }`）撑着 —— 那份清单在
          **另一个文件**里，于是往面板里加任何东西（一句提示、第二组按钮）都会
          **静静地掉进某一栏**：组件结构变了不报错，只有肉眼能发现。 */}
      <div className="panel-sliders">
        {PARAM_KEYS.map(k => (
          // 动过的那一条挂个 `on`，样式靠它把标签和数字点亮（见 styles.css 的
          // `.slider.on`）。**这是纯装饰**：值本身还是 value[k] 这**一个**来源，
          // 不存在"记号和数据对不上"。写法跟 Uploader 那个 `.over` 同款。
          // ⚠️ "动过没有"的判据来自 shared/adjustments 的 `isChanged` ——
          //    作品详情页那张表问的是同一件事，两处**必须同一个判据**。
          //
          // ★ 2026-10-01：滑块本体换成 `kit/Slider`（Base UI 的行为 + 我们的长相）。
          //   它自己就是一个原生 `<input type="range">`，**顺序和条数一个没变**，
          //   所以 `AdjustmentPanel.test.ts`（读源码守那 8 个键）照旧。
          <Slider
            key={k}
            label={PARAM_LABELS[k]}
            value={value[k]}
            min={PARAM_MIN}
            max={PARAM_MAX}
            changed={isChanged(value, k)}
            onChange={v => set(k, v)}
          />
        ))}
      </div>
    </aside>
  )
}
