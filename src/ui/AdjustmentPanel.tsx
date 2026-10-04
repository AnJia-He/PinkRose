import { useRef, useState } from 'react'
import { ChevronDown, Images } from 'lucide-react'
import {
  PARAM_GROUPS, PARAM_LABELS, PARAM_RANGE, isChanged,
  type Adjustments,
} from '../../shared/adjustments.ts'
import { PRESETS } from '../core/presets'
import { Slider } from './kit/Slider.tsx'
import { ColorWheel } from './ColorWheel.tsx'

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

/**
 * 哪几根滑块拖着一条**渐变轨**（轨道上每个位置各自对应一个色相/色温）。
 *
 * ⚠️ 这里的颜色是**内容色**、不是主题色 —— 和色轮那个色相环同类：渐变轨画的
 * 就是"这根轴两端各是什么颜色"这件事本身，换成主题令牌它就不表达那个意思了。
 * 这也是全站"样式只引用令牌"唯一一类有意的例外，别当漏网之鱼顺手改掉。
 * 挂在 `kit/Slider` 的 `gradient` 上时它**不再画填充段**（理由见 Slider.tsx）。
 */
const GRADIENTS: Partial<Record<keyof Adjustments, string>> = {
  temperature: 'linear-gradient(90deg, #2f7cf6, #ececf0 50%, #ffc83d)',
  cbCyanRed: 'linear-gradient(90deg, #22c1c3, #ececf0 50%, #ff4d4d)',
  cbMagentaGreen: 'linear-gradient(90deg, #e5399a, #ececf0 50%, #4caf50)',
  cbYellowBlue: 'linear-gradient(90deg, #ffcc00, #ececf0 50%, #2f7cf6)',
  splitHiHue: 'linear-gradient(90deg,#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)',
  splitLoHue: 'linear-gradient(90deg,#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)',
}

export default function AdjustmentPanel({ value, onChange, onReset, onMatchReference }: Props) {
  const refInput = useRef<HTMLInputElement>(null)

  // 收起了哪几组。**只有 id 的集合**，真值仍然只有 `value` 一个来源 ——
  // 折叠是"看哪儿"的问题，不属于那张参数表，也不该进网址（刷新后全展开是对的：
  // 收起来过的那几组是上一眼的事，不是这份作品的一部分）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>调色</span>
        <button onClick={onReset}>重置</button>
      </div>

      <div className="presets">
        {PRESETS.map(p => (
          // 展开拷贝：PRESETS 是模块级共享对象，直接传引用会让拖滑块改坏预设。
          // 这也是"套预设 = 新参数一并归零"那条行为的来路 —— 每个预设都是
          // `{...ZERO, …}` 的长拷贝，所以色彩平衡/分离色调会被**写回 0**，
          // 而不是原地留下上一份的色偏（测试：AdjustmentPanel.behavior.test.tsx）。
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

      {/* ★ 2026-10-04：十五条参数按 `PARAM_GROUPS` 分组（光效 / 色彩 / 色彩平衡 /
          分离色调 / 效果），每组可折叠。**分栏只发生在每一组的肚子里**（见
          `.panel-group-body`），面板本身仍是"头 / 预设 / 组"的竖列。
          ⚠️ 原来分栏直接写在 `.panel` 上，靠 CSS 里一份"谁横跨全宽"的类名清单
          （`.panel-head, .presets { grid-column: 1 / -1 }`）撑着 —— 那份清单在
          **另一个文件**里，于是往面板里加任何东西（一句提示、第二组按钮）都会
          **静静地掉进某一栏**：组件结构变了不报错，只有肉眼能发现。所以这里是
          层层嵌套的普通盒子，块与块的归属跟着 JSX 走，不再靠跨文件清单。
          ⚠️ 条数和每组的成员都从 `PARAM_GROUPS` 来，**一个字都不在这儿写死** ——
          加一根参数只改 `shared/adjustments.ts` 那一处（`AdjustmentPanel.test.ts`
          会读这份源码，挡住把标签抄回来的写法）。 */}
      <div className="panel-groups">
        {PARAM_GROUPS.map(g => (
          <section className="panel-group" key={g.id}>
            <button
              className="panel-group-head"
              // 收着 = false。**读屏用户就靠它知道这一组现在开着没有** ——
              // 状态全在这一个属性上，别只让箭头转个方向就算数。
              aria-expanded={!collapsed.has(g.id)}
              onClick={() => setCollapsed(prev => {
                const next = new Set(prev)
                if (next.has(g.id)) next.delete(g.id)
                else next.add(g.id)
                return next
              })}
            >
              <span className="panel-group-title">{g.title}</span>
              <ChevronDown
                size={14}
                className={collapsed.has(g.id) ? 'chev folded' : 'chev'}
                aria-hidden="true"
              />
            </button>
            {!collapsed.has(g.id) && (
              <div className="panel-group-body">
                {/* 色轮是**色彩平衡三根轴的二维视图**（不是第四个参数）：拖它 =
                    零和地写那三根轴，拖某一根轴 = 轮上那个点跟着走（见
                    `core/colorBalance.ts`）。它自己也 `aria-hidden` —— 键盘/
                    读屏的等价通路就是下面那三根轴本身，所以它不抢焦点。

                    ⚠️ 判据认 `g.id === 'balance'` 而不是标题文字：标题是给眼睛
                    看的，哪天改一个字，接线不该跟着断。 */}
                {g.id === 'balance' && (
                  <ColorWheel
                    axes={{
                      cbCyanRed: value.cbCyanRed,
                      cbMagentaGreen: value.cbMagentaGreen,
                      cbYellowBlue: value.cbYellowBlue,
                    }}
                    onChange={next => onChange({ ...value, ...next })}
                  />
                )}
                {g.keys.map(k => (
                  // 动过的那一条挂个 `on`，样式靠它把标签和数字点亮（见 styles.css
                  // 的 `.slider.on`）。**这是纯装饰**：值本身还是 value[k] 这
                  // **一个**来源，不存在"记号和数据对不上"。写法跟 Uploader 那个
                  // `.over` 同款。
                  // ⚠️ "动过没有"的判据来自 shared/adjustments 的 `isChanged` ——
                  //    作品详情页那张表问的是同一件事，两处**必须同一个判据**。
                  //
                  // ★ 2026-10-01：滑块本体换成 `kit/Slider`（Base UI 的行为 + 我们的
                  //   长相）。它自己就是一个原生 `<input type="range">`，顺序和条数
                  //   跟着 PARAM_GROUPS 走。
                  // ★ 2026-10-04：范围/标签/渐变都从各自那张表取 —— 色相是
                  //   [0, 360]、强度是 [0, 100]，**不再共用一套 ±100**。
                  <Slider
                    key={k}
                    label={PARAM_LABELS[k]}
                    value={value[k]}
                    min={PARAM_RANGE[k][0]}
                    max={PARAM_RANGE[k][1]}
                    changed={isChanged(value, k)}
                    gradient={GRADIENTS[k]}
                    onChange={v => onChange({ ...value, [k]: v })}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </aside>
  )
}
