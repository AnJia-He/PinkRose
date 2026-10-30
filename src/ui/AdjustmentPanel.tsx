import { useEffect, useRef, useState } from 'react'
import {
  Aperture, Blend, ChevronDown, ChevronUp, ClipboardPaste, Contrast, Copy, Droplet, Focus, Images, LayoutGrid, Monitor, RotateCcw,
  Palette, Pipette, Rainbow, Ruler, Scan, ScanSearch, Search, SlidersHorizontal, Smile, Spline, Sun, SunMoon, X,
} from 'lucide-react'
import { fileUrl, listWorks } from '../api/works.ts'
import {
  PARAM_GROUPS, PARAM_LABELS, PARAM_RANGE, ZERO, isChanged,
  type Adjustments,
} from '../../shared/adjustments.ts'
import type { HslBandId } from '../core/hslPick'
import { workName, type WorkMeta } from '../../shared/works.ts'
import type { Cube, LutMeta, LutRef } from '../../shared/lut.ts'
import type { PresetMeta } from '../../shared/preset.ts'
import { Slider } from './kit/Slider.tsx'
import { ColorWheel } from './ColorWheel.tsx'
import HslControls from './HslControls.tsx'
import ToneCurve from './ToneCurve.tsx'
import Histogram from './Histogram.tsx'
import type { HistogramData } from '../render/histogram'
import LutPicker from './LutPicker.tsx'
import { PresetManager } from './PresetManager.tsx'
import PhotoInfoPanel from './PhotoInfoPanel.tsx'
import LayerPanel from './LayerPanel.tsx'
import LensProfilePicker from './LensProfilePicker.tsx'
import LutExporter from './LutExporter.tsx'
import type { EditLayer } from '../../shared/layers.ts'
import type { ColorReading } from '../core/colorSample'
import {
  WHITE_BALANCE_PRESETS, activeWhiteBalancePreset, applyWhiteBalancePreset,
} from '../core/whiteBalancePresets'

/**
 * ★ 2026-10-08（用户原话：「给这些也找到合适的图标组件」—— 对着调色面板那几组说的）：
 * 十四个组头（Lut + 十三组参数）各配一个图标。选型照左栏那条规矩（见 `Nav.tsx` 顶部）：
 *   · **同一个概念全站同一个图标** —— Lut 用的滑杆就是左栏那格 / 对话加号里
 *     那一项用的 `SlidersHorizontal`，不在面板里另起一个；
 *   · **一个图标认一件事**，九颗摆在一列里一眼分得开：光效 = 太阳（明暗）、
 *     色彩 = 水滴（色）、黑白 = 明暗对比圆、色彩平衡 = 混合、分离色调 = 日月（高光=日 / 阴影=夜）、
 *     效果 = 光圈（清晰度 / 暗角这一类镜头感的东西）、
 *     细节 = 放大镜（锐化 / 降噪 / 颗粒，都是凑近看的东西）、
 *     HSL = 彩虹（八条色带）、曲线 = 一条折线（影调曲线）、
 *     美颜 = 笑脸（美白 / 红润）；几何 = 扫描框（透视校正）；镜头 = 焦点框（景深虚化）；
 *     镜头校正 = 尺子（直线是否还直）。
 *   · 尺寸跟这一屏的既有口径走（面板里 `Images`/`LayoutGrid`/箭头全是 14），
 *     线宽**显式** 1.5 —— 尺子守卫钉着"每个 lucide 图标都必须显式写"
 *     （不写就是 lucide 默认的 2，悄悄变粗）。
 * ⚠️ 图标是**装饰**：`aria-hidden` 必写 —— 名字是旁边那几个字，
 *   读屏和"按文字找元素"的测试都不该被 svg 搅到。
 */
const GROUP_ICONS = {
  light: Sun,
  color: Droplet,
  bw: Contrast,
  balance: Blend,
  split: SunMoon,
  effects: Aperture,
  detail: ScanSearch,
  hsl: Rainbow,
  curve: Spline,
  beauty: Smile,
  geometry: Scan,
  lens: Focus,
  lensFix: Ruler,
} as const

/** 组头那颗图标。单独一层只为一件事：把"从 id 取组件"收在一处（上面那张表）。 */
function GroupIcon({ id }: { id: (typeof PARAM_GROUPS)[number]['id'] }) {
  const Icon = GROUP_ICONS[id]
  return <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
}

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
  onReset: () => void
  /** 把当前参数和滤镜引用放进跨照片的调色剪贴板。 */
  onCopyAdjustments: () => void
  /** 把剪贴板里的调色套到当前照片。 */
  onPasteAdjustments: () => void
  canPasteAdjustments: boolean
  /** 编辑器手上这张原文件；用于按需读取 EXIF。 */
  photoFile: File | null
  image: { width: number; height: number }
  /** 刚套上的预设强度；undefined = 没挂预设，不画这一行。 */
  presetAmount?: number
  presetLabel?: string
  onPresetAmount?: (amount: number) => void
  /** 本地直方图分析后套一组保守的自动影调；不联网、不花钱。 */
  onAuto: () => void
  /** 本地采样后从内置预设里挑一套；动作在 App，面板只交出一次点击。 */
  onRecommend: () => void
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
  /** 当前 Lut 的 cube；导出当前外观时一起烘焙。 */
  lutCube?: Cube | null
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
  /**
   * ★ 2026-10-10（「我的预设」，设计 §5.1）：面板头那颗按钮展开出来的**存 / 管**。
   *
   * 分层照上面那条「照着这张调」：面板只**摆**，清单四态在 App（`usePresets`），
   * 存 / 改名 / 删三个动作也由 App 接线（**成功之后重拉清单**）—— 展开块
   * （`PresetManager`）只负责把失败翻成人话、就地说话。
   */
  presets: readonly PresetMeta[]
  presetsKnown: boolean
  onSavePreset: (name: string, params: Adjustments) => Promise<void>
  onRenamePreset: (id: number, name: string) => Promise<void>
  onDeletePreset: (id: number) => Promise<void>
  /** ★ 2026-10-17：白平衡吸管正在等用户点画面。 */
  whiteBalancePicking?: boolean
  onWhiteBalance?: () => void
  /** ★ 2026-10-19：HSL 定向调色正在等用户点画面取色。 */
  hslPicking?: boolean
  onHslPick?: () => void
  /** App 从照片颜色算出的色带；面板据此切到那一条。 */
  hslPickedBand?: HslBandId | null
  /** 同一个色带再次取色也要生效（用户可能先手选去了别的色带）。 */
  hslPickSeq?: number
  /** 点一下画面读取当前渲染颜色；只读数，不改参数。 */
  colorSampling?: boolean
  colorSample?: ColorReading | null
  onColorSample?: () => void
  onCopyColor?: () => void | Promise<void>
  /** 实时直方图（来自渲染管线的小离屏缓冲）；null / 不传 = 还没算出来。 */
  histogram?: HistogramData | null
  /** ★ 2026-10-19（统一图层面板）：文字 / 形状 / 贴纸 / 局部层。 */
  layers: readonly EditLayer[]
  onToggleLayer: (id: string) => void
  onMoveLayer: (id: string, dir: 'up' | 'down') => void
  onDeleteLayer: (id: string) => void
  onEditLayer: (id: string) => void
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
  splitMidHue: 'linear-gradient(90deg,#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)',
}

export default function AdjustmentPanel({
  value, onChange, onReset, onCopyAdjustments, onPasteAdjustments, canPasteAdjustments,
  photoFile, image,
  onAuto, onRecommend, onMatchReference, onMatchWork,
  luts, lutsKnown, lut, lutCube, lutThumbs, onPickLut, onLutAmount, onNeedLutThumbs, onGoImport, onRetryLuts,
  presets, presetsKnown, onSavePreset, onRenamePreset, onDeletePreset,
  whiteBalancePicking = false, onWhiteBalance,
  hslPicking = false, onHslPick, hslPickedBand = null, hslPickSeq = 0,
  colorSampling = false, colorSample = null, onColorSample, onCopyColor,
  histogram,
  layers, onToggleLayer, onMoveLayer, onDeleteLayer, onEditLayer,
  defaultLutOpen = false,
  presetAmount, presetLabel, onPresetAmount,
}: Props) {
  const refInput = useRef<HTMLInputElement>(null)

  // 收起了哪几组。**只有 id 的集合**，真值仍然只有 `value` 一个来源 ——
  // 折叠是"看哪儿"的问题，不属于那张参数表，也不该进网址（刷新后全展开是对的：
  // 收起来过的那几组是上一眼的事，不是这份作品的一部分）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  // 手机上的参数面板占约 40vh。收起后把这块高度还给照片，同时把入口留在原处；
  // 桌面面板是右侧常驻栏，按钮由 CSS 隐藏，不会把整栏关掉。
  // 短视口（iPhone Safari 内容区常见 664~760px）默认先给照片，点一下再展开参数；
  // 高一些的手机仍保持展开，避免每张图都多一次点击。
  const [panelCollapsed, setPanelCollapsed] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= 640 && window.innerHeight <= 760)
  const [query, setQuery] = useState('')

  // ★ 2026-10-05：「滤镜」那一栏开着没有。**默认收着**（设计 §5.2 / spec §8.3：
  //   用户原话「不要写个名字显示出来占空间」）—— 所以它不在上面那个
  //   `collapsed` 集合里：那套的默认是"全展开"，这一栏的默认是"收着"。
  //   `defaultLutOpen` 只从「滤镜」那一页那条路来（见 Props 那段）。
  const [lutOpen, setLutOpen] = useState(defaultLutOpen)
  const [hslBandId, setHslBandId] = useState<HslBandId>('red')

  // 照片取色回来后切到那条色带。值相同就不动，用户手选的色带不会被无谓打断。
  useEffect(() => {
    if (hslPickedBand) setHslBandId(hslPickedBand)
  }, [hslPickedBand, hslPickSeq])

  useEffect(() => {
    if (query.trim()) setCollapsed(new Set())
  }, [query])

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
   * 「照着这张调」展开出来的两个来源（★ 2026-10-05）。
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
  const tiltLens = value.lensShape > 50

  /**
   * ★ 2026-10-10：「我的预设」那一块里面开着没有。**默认收着**（和滤镜那一栏
   *   同一条：收着是常态，别一进调色屏就占一截）。展开的内容是 `PresetManager`
   *   整块 —— 它不进上面那个 `collapsed` 集合（那套管的是十一组参数的默认展开）。
   */
  const [mineOpen, setMineOpen] = useState(false)

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

  const needle = query.trim().toLocaleLowerCase('zh-CN')
  const matchingGroups = needle
    ? PARAM_GROUPS.filter(g =>
        g.title.toLocaleLowerCase('zh-CN').includes(needle)
        || g.keys.some(k => PARAM_LABELS[k].toLocaleLowerCase('zh-CN').includes(needle)))
    : PARAM_GROUPS

  return (
    <aside className={`panel${panelCollapsed ? ' panel-collapsed' : ''}`}>
      <div className="panel-head">
        <span>调色</span>
        {/* ★ 2026-10-10（「我的预设」，设计 §5.1）：存 / 改 / 删自己攒的那几套
            参数。**住在面板头上** —— 它和「重置」都是"对整套参数"的动作，而
            下面那些组是"对一根参数"的。
            ⚠️ 点开是**就地展开**（`PresetManager` 就摊在下面），不是弹窗 ——
            全站没有弹窗文化（用户原话「调色就是对图片微调的界面区」）。
            摆设位置：头和「照着这张调」之间（它是对"这一套参数"的动作，
            和「照着这张调」这种"产出一套参数"的按钮分开）。 */}
        <button className="presets-mine" aria-expanded={mineOpen}
                onClick={() => setMineOpen(o => !o)}>
          我的预设
        </button>
        <button className="panel-recommend" onClick={onRecommend}>推荐</button>
        <button className="panel-auto" onClick={onAuto}>自动</button>
        <button onClick={onReset}>重置</button>
        <button
          type="button"
          className="panel-collapse-toggle"
          aria-expanded={!panelCollapsed}
          aria-controls="adjustment-panel-content"
          aria-label={panelCollapsed ? '展开调色参数' : '收起调色面板'}
          title={panelCollapsed ? '展开调色参数，查看大图' : '收起调色面板，查看大图'}
          onClick={() => setPanelCollapsed(v => !v)}
        >
          {panelCollapsed
            ? <ChevronUp size={16} strokeWidth={1.5} aria-hidden="true" />
            : <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />}
        </button>
      </div>
      <div className="panel-content" id="adjustment-panel-content">
      <div className="panel-clipboard" role="group" aria-label="调色剪贴板">
        <button type="button" className="crop-chip" onClick={onCopyAdjustments}>
          <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
          复制调色
        </button>
        <button
          type="button"
          className="crop-chip"
          disabled={!canPasteAdjustments}
          onClick={onPasteAdjustments}
        >
          <ClipboardPaste size={14} strokeWidth={1.5} aria-hidden="true" />
          粘贴调色
        </button>
        {onColorSample && (
          <button
            type="button"
            className={`crop-chip${colorSampling ? ' on' : ''}`}
            aria-label="颜色取样"
            aria-pressed={colorSampling}
            onClick={onColorSample}
          >
            <Palette size={14} strokeWidth={1.5} aria-hidden="true" />
            {colorSampling ? '点照片取色' : '颜色取样'}
          </button>
        )}
        <PhotoInfoPanel file={photoFile} width={image.width} height={image.height} />
      </div>
      {colorSample && (
        <div className="color-sample" aria-label="颜色读数">
          <span
            className="color-sample-swatch"
            style={{ background: colorSample.hex }}
            aria-hidden="true"
          />
          <code className="color-sample-hex">{colorSample.hex}</code>
          <span>RGB {colorSample.rgb.join(' · ')}</span>
          <span>HSL {colorSample.hsl[0]}° · {colorSample.hsl[1]}% · {colorSample.hsl[2]}%</span>
          {onCopyColor && (
            <button
              type="button"
              className="color-sample-copy"
              aria-label={`复制颜色 ${colorSample.hex}`}
              onClick={() => void onCopyColor()}
            >复制</button>
          )}
        </div>
      )}

      <div className="panel-search" role="search">
        <Search size={14} strokeWidth={1.5} aria-hidden="true" />
        <input
          value={query}
          aria-label="搜索调色参数"
          aria-controls="panel-param-groups"
          placeholder="搜索参数，例如 亮度 / 色温"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            setQuery('')
          }}
        />
        {query && (
          <button
            type="button"
            className="panel-search-clear"
            aria-label="清除参数搜索"
            onClick={() => setQuery('')}
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
      {needle && matchingGroups.length === 0 && (
        <p className="panel-search-empty" role="status">
          没有找到「{query.trim()}」对应的调色参数。
        </p>
      )}

      {mineOpen && (
        <PresetManager presets={presets} known={presetsKnown} params={value}
          onSave={onSavePreset} onRename={onRenamePreset} onDelete={onDeletePreset} />
      )}

      <Histogram data={histogram} />

      <LayerPanel
        layers={layers}
        onToggle={onToggleLayer}
        onMove={onMoveLayer}
        onDelete={onDeleteLayer}
        onEdit={onEditLayer}
      />

      {presetAmount !== undefined && onPresetAmount && (
        <Slider
          label={presetLabel ? `${presetLabel}强度` : '预设强度'}
          value={presetAmount}
          min={0}
          max={100}
          changed={presetAmount !== 100}
          onChange={onPresetAmount}
        />
      )}

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
        照着这张调
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
        accept="image/*,.heic,.heif"
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
          两次一样的名字。这一屏的面板从此只有"滤镜 + 九十四个参数"。

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
          <span className="panel-group-title">
            <SlidersHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />
            Lut
          </span>
          <ChevronDown size={14} strokeWidth={1.5} className={lutOpen ? 'chev' : 'chev folded'} aria-hidden="true" />
        </button>
        {lutOpen && (
          <div className="panel-group-body">
            <LutPicker luts={luts} lutsKnown={lutsKnown} value={lut} thumbs={lutThumbs.byId}
              noneThumb={lutThumbs.none} onPick={onPickLut} onAmount={onLutAmount}
              onGoImport={onGoImport} onRetryLuts={onRetryLuts} />
            <LutExporter
              params={value}
              cube={lutCube ?? null}
              lutAmount={lut?.amount ?? 0}
              filenameStem={photoFile?.name}
            />
          </div>
        )}
      </section>

      {/* ★ 2026-10-04：九十四个参数按 `PARAM_GROUPS` 分组（光效 / 色彩 / 黑白 / 色彩平衡 /
          分离色调 / 效果 / 细节 / HSL / 曲线 / 美颜 / 几何 / 镜头 / 镜头校正），每组可折叠。**分栏只发生在每一组的肚子里**（见
          `.panel-group-body`），面板本身仍是"头 / 预设 / 组"的竖列。
          ⚠️ 原来分栏直接写在 `.panel` 上，靠 CSS 里一份"谁横跨全宽"的类名清单
          （`.panel-head, .presets { grid-column: 1 / -1 }`）撑着 —— 那份清单在
          **另一个文件**里，于是往面板里加任何东西（一句提示、第二组按钮）都会
          **静静地掉进某一栏**：组件结构变了不报错，只有肉眼能发现。所以这里是
          层层嵌套的普通盒子，块与块的归属跟着 JSX 走，不再靠跨文件清单。
          ⚠️ 条数和每组的成员都从 `PARAM_GROUPS` 来，**一个字都不在这儿写死** ——
          加一根参数只改 `shared/adjustments.ts` 那一处（`AdjustmentPanel.test.ts`
          会读这份源码，挡住把标签抄回来的写法）。 */}
      <div className="panel-groups" id="panel-param-groups">
        {matchingGroups.map(g => {
          const changed = g.keys.some(key => isChanged(value, key))
          return (
          <section className="panel-group" key={g.id}>
            <div className="panel-group-head-row">
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
                <span className="panel-group-title">
                  <GroupIcon id={g.id} />
                  {g.title}
                </span>
                <ChevronDown
                  size={14}
                  className={collapsed.has(g.id) ? 'chev folded' : 'chev'}
                  aria-hidden="true"
                />
              </button>
              {changed && (
                <button
                  type="button"
                  className="panel-group-reset"
                  aria-label={`重置${g.title}`}
                  title={`只把「${g.title}」这一组恢复默认`}
                  onClick={() => {
                    const next = { ...value }
                    for (const key of g.keys) next[key] = ZERO[key]
                    onChange(next)
                  }}
                >
                  <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
                </button>
              )}
            </div>
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
                {g.id === 'hsl' ? (
                  <HslControls
                    value={value}
                    onChange={onChange}
                    bandId={hslBandId}
                    onBand={setHslBandId}
                    picking={hslPicking}
                    onPick={onHslPick}
                  />
                ) : g.id === 'curve' ? (
                  <ToneCurve value={value} onChange={onChange} />
                ) : (
                  <>
                    {g.id === 'color' && (
                      <div
                        className="retouch-modes wb-presets"
                        role="group"
                        aria-label="白平衡预设"
                      >
                        {WHITE_BALANCE_PRESETS.map(preset => {
                          const on = activeWhiteBalancePreset(value) === preset.id
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`crop-chip${on ? ' on' : ''}`}
                              aria-pressed={on}
                              onClick={() => onChange(applyWhiteBalancePreset(value, preset.id))}
                            >{preset.label}</button>
                          )
                        })}
                      </div>
                    )}
                    {g.id === 'lens' && (
                      <div className="retouch-modes" role="group" aria-label="虚化方式">
                        <button
                          type="button"
                          className={`crop-chip${tiltLens ? '' : ' on'}`}
                          aria-pressed={!tiltLens}
                          onClick={() => onChange({ ...value, lensShape: 0 })}
                        >径向</button>
                        <button
                          type="button"
                          className={`crop-chip${tiltLens ? ' on' : ''}`}
                          aria-pressed={tiltLens}
                          onClick={() => onChange({ ...value, lensShape: 100 })}
                        >移轴</button>
                      </div>
                    )}
                    {g.id === 'lensFix' && (
                      <LensProfilePicker
                        file={photoFile}
                        value={value}
                        onChange={onChange}
                      />
                    )}
                    {g.keys.filter(k => g.id !== 'lens'
                      || (k !== 'lensShape'
                        && (!tiltLens || k !== 'lensFocusX')
                        && (tiltLens || k !== 'lensAngle'))).map(k => (
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
                        label={g.id === 'lens' && tiltLens && k === 'lensFocusY'
                          ? '清晰带位置'
                          : PARAM_LABELS[k]}
                        value={value[k]}
                        min={PARAM_RANGE[k][0]}
                        max={PARAM_RANGE[k][1]}
                        changed={isChanged(value, k)}
                        gradient={GRADIENTS[k]}
                        onChange={v => onChange({ ...value, [k]: v })}
                      />
                    ))}
                    {g.id === 'color' && onWhiteBalance && (
                      <button
                        type="button"
                        className={`wb-picker${whiteBalancePicking ? ' on' : ''}`}
                        aria-pressed={whiteBalancePicking}
                        onClick={onWhiteBalance}
                      >
                        <Pipette size={14} strokeWidth={1.5} aria-hidden="true" />
                        白平衡吸管
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
          )
        })}
      </div>
      </div>
    </aside>
  )
}
