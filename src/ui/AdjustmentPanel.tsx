import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Images, LayoutGrid, Monitor } from 'lucide-react'
import { fileUrl, listWorks } from '../api/works.ts'
import {
  PARAM_GROUPS, PARAM_LABELS, PARAM_RANGE, isChanged,
  type Adjustments,
} from '../../shared/adjustments.ts'
import { workName, type WorkMeta } from '../../shared/works.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import { Slider } from './kit/Slider.tsx'
import { ColorWheel } from './ColorWheel.tsx'
import LutPicker from './LutPicker.tsx'

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
  /**
   * 参考图的**第二个来源**：用户从自己的作品里挑了一张（★ 2026-10-05，
   * 用户：「这个用户应该有两个来源，一个是以往作品效果，一个是本地照片」）。
   *
   * 面板只交**选中了哪张**（`WorkMeta`）：取图字节、解码、拟合都在 App 那边 ——
   * 和 `onMatchReference` 同一条分层（面板不碰网络、不碰像素）。
   * ⚠️ 网格里那些 `<img src={fileUrl(w)}>` 不算破例：图是**浏览器自己**去取的
   * （`api/works.ts` 里写着这个分工），面板只是给出网址。
   */
  onMatchWork: (w: WorkMeta) => void
  /**
   * ★ 2026-10-05（滤镜，设计 §5.2）：清单、现在用着哪个、缩略图。
   *
   * 面板只**摆**这些东西，状态全在 App 那边 —— 和上面两条「照着这张调」同一个
   * 分层：这一层管长相，取字节 / 解析 cube / 画缩略图都在 App 和 `app/useLuts`。
   */
  luts: readonly LutMeta[]
  /** ★ 2026-10-05 终审修复：清单**到手了没有**（看 `LutPicker` 的 `lutsKnown`）。 */
  lutsKnown: boolean
  /** 现在用着哪个（null = 不用）。**有它的时候这一栏的标题点亮**（§5.2）。 */
  lut: LutRef | null
  /** 缩略图：`byId` 是 id → dataURL（缺的那格画占位），`none` 是「不用」那格。 */
  lutThumbs: { none: string | null; byId: Record<number, string> }
  onPickLut: (lutId: number | null) => void
  onLutAmount: (amount: number) => void
  /** 这一栏**展开那一刻**叫一次 —— 缩略图很贵（每个滤镜各画一张），收着时不画。 */
  onNeedLutThumbs: () => void
  /**
   * ★ 2026-10-05：「滤镜」那一栏**进来就展开**（默认收着）。
   *
   * 只有一条路会传 true：从「滤镜」那一页按「去调色里套一张」过来（用户原话
   * 「我没看到怎么去调用 lut 文件」——他找不到，那就别再让他找第二遍）。
   * ⚠️ 它是**初始值**不是受控值：之后用户自己开合，这边不再插手。
   */
  defaultLutOpen?: boolean
  /** 一个滤镜都没有时那颗「去导入」（跳到设置里那一页）。 */
  onGoImport: () => void
  /** 清单没到手时那颗「再试一次」（重拉一次清单）。 */
  onRetryLuts: () => void
}

/**
 * 「从我的作品里选」那张清单的四态（★ 2026-10-05）。
 *
 * **不拿空数组顶"还没拉到"** —— "你的作品集是空的"是一句关于他资产的话，
 * 只该在真的拉到空清单时说（`AccountPage` 的 `Usage` 同一个道理）。
 * 失败留在 `fail`：再点一下「从我的作品里选」就重来一次。
 */
type WorksState =
  | { s: 'idle' }
  | { s: 'loading' }
  | { s: 'ready'; list: WorkMeta[] }
  | { s: 'fail' }

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

export default function AdjustmentPanel({
  value, onChange, onReset, onMatchReference, onMatchWork,
  luts, lutsKnown, lut, lutThumbs, onPickLut, onLutAmount, onNeedLutThumbs, onGoImport, onRetryLuts,
  defaultLutOpen = false,
}: Props) {
  const refInput = useRef<HTMLInputElement>(null)

  // 收起了哪几组。**只有 id 的集合**，真值仍然只有 `value` 一个来源 ——
  // 折叠是"看哪儿"的问题，不属于那张参数表，也不该进网址（刷新后全展开是对的：
  // 收起来过的那几组是上一眼的事，不是这份作品的一部分）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  // ★ 2026-10-05：「滤镜」那一栏开着没有。**默认收着**（设计 §5.2 / spec §8.3：
  //   用户原话「不要写个名字显示出来占空间」）—— 所以它不在上面那个
  //   `collapsed` 集合里：那套的默认是"全展开"，这一栏的默认是"收着"。
  //   `defaultLutOpen` 只从「滤镜」那一页那条路来（见 Props 那段）。
  const [lutOpen, setLutOpen] = useState(defaultLutOpen)

  /**
   * 这一栏**开着**的时候去要缩略图（很贵：每个滤镜各画一张当前照片）。
   *
   * ⚠️ **依赖里必须有 `luts`**（★ 2026-10-05 真机抓到的那条）：
   *    从「滤镜」那一页导完一个、按「去调色里套一张」过来的那一刻，App 手上那份
   *    清单**可能还是旧的（空的）** —— 它是在离开那一页之后才重拉的。只在"打开
   *    那一刻"叫一次的话，这一次会一条都画不出来，而**没有任何东西会再叫第二次**：
   *    用户看到的是一栏开着、格子里全是**灰方块**（看着像加载失败），永远不变。
   *    （真机探针量到的：`.lut-tile` 2 格、`.lut-tile img` 只有 1 张。）
   * ⚠️ 清单是空的时**不叫**：那种时候这一栏显示的是「还没有导入过滤镜。」，
   *    一张缩略图都用不上（原来那颗按钮的 onClick 是无条件叫的，白画一趟）。
   */
  useEffect(() => {
    if (lutOpen && luts.length > 0) onNeedLutThumbs()
  }, [lutOpen, luts])

  /**
   * 「放置预期效果照片」展开出来的两个来源（★ 2026-10-05）。
   *
   * · `refOpen`   —— 大按钮点开/收起，两颗来源行（和可能展开的网格）都挂它下面；
   * · `worksOpen` —— 「从我的作品里选」的网格开着没有；
   * · `works`     —— 清单四态（见上面的 `WorksState`）。
   *
   * **就地展开、不弹浮层**：这一屏没有弹窗文化（用户原话「调色就是对图片微调的
   * 界面区不是对话区」），浮层还多一层"怎么关"的焦虑 —— 就地展开没有，再点一下
   * 大按钮就是收起。
   */
  const [refOpen, setRefOpen] = useState(false)
  const [worksOpen, setWorksOpen] = useState(false)
  const [works, setWorks] = useState<WorksState>({ s: 'idle' })

  // 卸载之后晚到的清单响应不再写状态（AccountPage 同款理由：别写进一棵不存在的树）。
  // ⚠️⚠️ **下一行 `alive.current = true` 是必须的，别删**（2026-10-05 真机抓到）：
  //   StrictMode 在开发模式会把"挂载 → 卸载 → 再挂载"整个重放一遍 —— 第一次
  //   cleanup 把 `alive.current` 置成 false 之后，effect 会**第二次运行**，不拨回
  //   true 的话它就永远是 false：promise 明明回来了，每次都被这行拦下，
  //   界面永远停在「正在找你的作品…」（测试里 App 不走 StrictMode，全绿 ——
  //   这正是"测试绿而真机死"的那一类，只有真机探针能抓）。
  //   （AccountPage 那份没这个坑，因为它用的是 effect 里的**闭包变量**，
  //     每次 effect 重跑都是一个新变量；这份要在点击处理器里用，才用的 ref。）
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadWorks = () => {
    setWorks({ s: 'loading' })
    listWorks().then(
      (list) => { if (alive.current) setWorks({ s: 'ready', list }) },
      () => { if (alive.current) setWorks({ s: 'fail' }) },
    )
  }

  const toggleWorks = () => {
    // 失败中再点 = **重试**（提示文案就是这么说的："再点一下试试"），
    // 而不是把格子收起来 —— 收起来等于让用户点了两下才有反应。
    if (worksOpen && works.s === 'fail') { loadWorks(); return }
    const next = !worksOpen
    setWorksOpen(next)
    // 首次打开拉一次；拉到过就不重复拉（重新挂载面板才会再拉）。
    if (next && works.s === 'idle') loadWorks()
  }

  /** 选好了（本地文件或作品都算）—— 展开区整个收起。 */
  const closeRef = () => { setRefOpen(false); setWorksOpen(false) }

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>调色</span>
        <button onClick={onReset}>重置</button>
      </div>

      {/* 「照着这张调」**故意摆在最前**（那排药丸搬走之后它就是这一栏的第一颗），
          两条理由：
          · 它点了会先展开来源、**不是立刻生效** —— 和下面那些"拖一下就有结果"
            的东西分开摆，用户才不会以为按下去画面就该变；
          · 它和预设本来是同一类东西（都产出一组参数），所以摆在这一栏第一眼的位置
            —— 和照片左边那条预设栏对着看，是"自己挑一个风格 / 让机器照着学一个"。
          而它跟上排**是同一类东西**（产出一组参数），所以紧挨着它们。
          ⚠️ 用真的 `<button>` 而不是 `<label>` 包一个 input：全站那套按钮的长相
          （底色/边框/悬停/按下/禁用）都在 CSS 的 `button` 那条通用规则里，
          用 label 就得把那一整套抄一遍 —— 抄完就多一份会漂的长相。
          ★ 2026-10-05：点它先展开**两个来源**（从我的作品里选 / 从电脑里选）——
          用户：「这个用户应该有两个来源，一个是以往作品效果，一个是本地照片」，
          形态（就地展开）见上面 `refOpen` 那段注释。 */}
      <button className="presets-ref" aria-expanded={refOpen}
        onClick={() => setRefOpen(o => {
          // 收起时把网格也一并收掉，别留一个"下次打开还开着"的隐藏状态。
          if (o) setWorksOpen(false)
          return !o
        })}>
        <Images size={14} strokeWidth={1.5} aria-hidden="true" />
        放置预期效果照片
      </button>

      {refOpen && (
        <div className="presets-sources">
          {/* 来源一：自己的作品（★ 2026-10-05 新增的路）。
              ⚠️ 缩略图 `alt` 用 `workName` —— 屏幕阅读器报出来的就是他给这张图
              起的名字（没起名则是时间），和作品集里看到的叫法一致。 */}
          <button className="presets-source" aria-expanded={worksOpen} onClick={toggleWorks}>
            <LayoutGrid size={14} strokeWidth={1.5} aria-hidden="true" />
            从我的作品里选
          </button>

          {worksOpen && (
            <>
              {works.s === 'loading' && <p className="presets-works-note">正在找你的作品…</p>}
              {works.s === 'fail' && (
                <p className="presets-works-note">没取到作品清单 —— 再点一下「从我的作品里选」试试。</p>
              )}
              {works.s === 'ready' && (works.list.length === 0 ? (
                // 真的拉到了、真的是空的 —— 这时才说「还没有」。
                <p className="presets-works-note">还没有存过作品 —— 先用「从电脑里选」放一张吧。</p>
              ) : (
                <div className="presets-works">
                  {works.list.map(w => (
                    <button key={w.id} className="presets-work"
                      onClick={() => { onMatchWork(w); closeRef() }}>
                      <img className="presets-work-thumb" src={fileUrl(w)}
                        alt={workName(w, Date.now())} loading="lazy" />
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          {/* 来源二：电脑里的照片 —— 原来唯一的那条路，行为原样。 */}
          <button className="presets-source" onClick={() => refInput.current?.click()}>
            <Monitor size={14} strokeWidth={1.5} aria-hidden="true" />
            从电脑里选
          </button>
        </div>
      )}

      <input
        ref={refInput}
        className="presets-ref-file"
        type="file"
        accept="image/*"
        onChange={e => {
          const f = e.target.files?.[0]
          // 选完就收起展开区（两条来源一致：挑好了 = 这个动作做完了）。
          // ⚠️ 用户点「取消」时 files 为空 —— 什么都不动，展开区留着让他重选。
          if (f) { onMatchReference(f); closeRef() }
          // 清空 value：同一张参考图连选两次也要能再触发一次 change
          e.target.value = ''
        }}
      />

      {/* ★ 2026-10-05：那排**文字药丸**（日系通透/胶片/黄昏…）搬去照片左边那条
          预设栏了（`ui/PresetRail`）—— 同一个功能在屏幕上出现两遍，用户会看见
          两次一样的名字。这一屏的面板从此只有"滤镜 + 十五条参数"。

          ⚠️ 原来那条注释（"这一栏是 `.presets` 的兄弟，因为 `.presets button`
          的选择器特异性比 `.lut-tile` 强"）**随那排药丸一起失效了** —— `.presets`
          那段 CSS 已经删掉。位置没动，是因为它本来就该在参数组前面。 */}

      {/* ★ 2026-10-05：滤镜那一栏（设计 §5.2）。**默认收着**是有意的 ——
          spec §8.3 记着用户原话「不要写个名字显示出来占空间」。

          ⚠️ 展开才去要缩略图（每个滤镜各画一张当前照片，很贵）—— 收着的时候
          白画一遍是纯浪费，而用户看不见，也没人会报错。 */}
      <section className="panel-group">
        <button className={lut ? 'panel-group-head on' : 'panel-group-head'}
          aria-expanded={lutOpen}
          onClick={() => setLutOpen((o) => !o)}>
          {/* ⚠️ 缩略图不在这颗按钮的 onClick 里要了 —— 那件事现在是上面那条
              effect 的活（"开着 + 清单非空"就是全部条件）。两处都叫的话，打开
              那一下会连画两趟（第二趟把第一趟作废，纯白烧）。 */}
          <span className="panel-group-title">滤镜</span>
          <ChevronDown size={14} className={lutOpen ? 'chev' : 'chev folded'} aria-hidden="true" />
        </button>
        {lutOpen && (
          <div className="panel-group-body">
            <LutPicker luts={luts} lutsKnown={lutsKnown} value={lut} thumbs={lutThumbs.byId}
              noneThumb={lutThumbs.none} onPick={onPickLut} onAmount={onLutAmount}
              onGoImport={onGoImport} onRetryLuts={onRetryLuts} />
          </div>
        )}
      </section>

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
