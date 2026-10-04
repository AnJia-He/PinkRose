/**
 * 十五个调色参数。**顺序 = `PARAM_KEYS` 的顺序 = 面板显示顺序**。
 *
 * 老八根（exposure / contrast / highlights / shadows / saturation /
 * temperature / clarity / vignette）的字段名一个字没动；后面七条是
 * 2026-10-04「专业面板」加进来的（自然饱和度 / 色彩平衡三轴 / 分离色调）。
 */
export type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  temperature: number
  vibrance: number
  saturation: number
  cbCyanRed: number
  cbMagentaGreen: number
  cbYellowBlue: number
  splitHiHue: number
  splitLoHue: number
  splitAmount: number
  clarity: number
  vignette: number
}

/**
 * 十五个参数的键，**顺序 = 面板显示顺序**（分组见 `PARAM_GROUPS`）。
 * ⚠️ 顺序有消费者：调色面板、作品详情页的"改过哪些"都按它出现。
 */
export const PARAM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows',
  'temperature', 'vibrance', 'saturation',
  'cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue',
  'splitHiHue', 'splitLoHue', 'splitAmount',
  'clarity', 'vignette',
] as const satisfies readonly (keyof Adjustments)[]

/**
 * 十五个参数在**界面上**叫什么。
 *
 * ⚠️ **这是两个界面共用的唯一一份。** 微调面板和作品详情页都从这里取 ——
 * 两处各写一份的话一定会漂，而漂了之后没人会发现（两边各自都"看起来对"）。
 * `src/ui/AdjustmentPanel.test.ts` 会读面板的源码，断言它没有自己写死一份。
 *
 * 注意"唯一"的范围只到界面这一侧：`server/prompt.ts` 里还有一份**措辞故意不同**的
 * （那是给模型的 prompt 用的，比如 `clarity` 在那边是「通透度」）。两份的消费者不同，
 * 所以措辞不同是对的；但界面这一侧只许有这一份 —— 别把本段的"唯一"读成全仓库唯一。
 *
 * `exposure` 显示成「亮度」而不是「曝光」，两条理由（§3.5.2）：
 * - 我们的用户（醒图 / 美图那一类）**找的是「亮度」**，找不着，教学就断在这儿
 * - **Lightroom 里"曝光"是 EV（-5.00 ~ +5.00）**，而我们是 -100 ~ +100 ——
 *   挂在"曝光"这个名字下会让用过 Lightroom 的人**误判数量级**
 *
 * ⚠️ **只改显示名，字段名 `exposure` 一个字不动** —— 改字段名会牵动 shader。
 */
export const PARAM_LABELS: Record<keyof Adjustments, string> = {
  exposure: '亮度',
  contrast: '对比度',
  highlights: '高光',
  shadows: '阴影',
  saturation: '饱和度',
  temperature: '色温',
  clarity: '清晰度',
  vignette: '暗角',
  // ★ 2026-10-04「专业面板」新增的七条 —— 下面的字就是用户看到的
  vibrance: '自然饱和度',
  cbCyanRed: '青 — 红',
  cbMagentaGreen: '洋红 — 绿',
  cbYellowBlue: '黄 — 蓝',
  splitHiHue: '亮部颜色',
  splitLoHue: '暗部颜色',
  splitAmount: '强度',
}

/**
 * 每个参数的取值范围。**默认 -100~100，例外逐条写在这儿** ——
 * 面板滑块、clamp、数字输入框都从这里取，一处定义。
 * ⚠️ 加例外时想一遍：这个参数的"中立点"还是不是 0？（复零／`isChanged` 都按 0 算）
 */
export const PARAM_RANGE: Record<keyof Adjustments, readonly [number, number]> = {
  exposure: [-100, 100], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  saturation: [-100, 100], temperature: [-100, 100], clarity: [-100, 100], vignette: [-100, 100],
  vibrance: [-100, 100],
  cbCyanRed: [-100, 100], cbMagentaGreen: [-100, 100], cbYellowBlue: [-100, 100],
  splitHiHue: [0, 360], splitLoHue: [0, 360], splitAmount: [0, 100],
}

/** 面板上的分组（顺序就是显示顺序）。`id` 给界面认（比如色彩平衡那组里还要画色轮）。 */
export const PARAM_GROUPS: readonly {
  id: 'light' | 'color' | 'balance' | 'split' | 'effects'
  title: string
  keys: readonly (keyof Adjustments)[]
}[] = [
  { id: 'light', title: '光效', keys: ['exposure', 'contrast', 'highlights', 'shadows'] },
  { id: 'color', title: '色彩', keys: ['temperature', 'vibrance', 'saturation'] },
  { id: 'balance', title: '色彩平衡', keys: ['cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue'] },
  { id: 'split', title: '分离色调', keys: ['splitHiHue', 'splitLoHue', 'splitAmount'] },
  { id: 'effects', title: '效果', keys: ['clarity', 'vignette'] },
]

/**
 * 全零参数。
 *
 * Object.freeze 是必须的：它是模块级单例，被 React state 按引用持有、
 * 又被当成重置目标（`setParams(ZERO)`）。谁要是原地改了它（`ZERO.x = 1`），
 * 污染的是所有人的重置目标，而且现象极难查。冻结后这类写法会立刻报错。
 * 正常的更新路径（`{...ZERO, x: 1}`）不受影响。
 */
export const ZERO: Adjustments = Object.freeze({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, clarity: 0, vignette: 0,
  // ★ 2026-10-04 新增的七条 —— 中立点也全是 0（色相 0 时强度也是 0，效果为零）
  vibrance: 0,
  cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0,
  splitHiHue: 0, splitLoHue: 0, splitAmount: 0,
})

/**
 * 参数**增量**（`ParamDeltas`）的统一范围：[-100, 100]。
 *
 * ⚠️ 参数**本身**的范围不再统一 —— 色相 0~360、强度 0~100。要取某一条的
 * 上下界请走 `PARAM_RANGE`；这里保留是因为"增量一律是 ±100 的整数档位"
 * 那条路（`server/validate.ts` 的 `normalizeDeltas`）还在按它钳。
 */
export const PARAM_MIN = -100
export const PARAM_MAX = 100

/**
 * 这一条**动过没有**。
 *
 * 两个界面各问过这个问题一次，而且问的是同一件事：
 *   · 微调面板 —— 这一条滑块要不要点亮（`AdjustmentPanel.tsx`）；
 *   · 作品详情页 —— 「这张图怎么来的」那张表里要不要列它（`WorkDetailPage.tsx`）。
 * 判据各写一份的话，哪天它变了（比如以后 ±2 以内都算没动），会出现**两个屏幕
 * 对同一张图说法不一致**：详情页说"这一张是原样，没有调过色"，而面板那边
 * 照样亮着。所以和 `PARAM_LABELS` 同款处理：抽出来，界面这一侧只许有这一份。
 *
 * ⚠️ 判的是**相对中立值**，不是"和上一次比"。十五个参数都是"0 = 什么都没做"
 * （见 `ZERO`），所以 0 就是那个中立值。
 */
export const isChanged = (a: Adjustments, k: keyof Adjustments): boolean => a[k] !== 0

/**
 * 按 `PARAM_RANGE` 把某一个字段钳到它自己那一段。
 *
 * `k` 要逐条写死（而不是在 `clampAdjustments` 里循环）：某个字段漏掉了，
 * 编译期就红 —— 循环写法会静默跳过，那一个参数从此钳不住，
 * 而所有别的断言照绿。
 *
 * 非有限值（NaN / ±Infinity）一律当中立 0。
 * 只写 Math.min(hi, NaN) 是没用的——结果还是 NaN，它会一路穿过
 * clampAdjustments / toUnit 进到 shader uniform 里，画面整体坏掉且无从排查。
 * **老数据缺的新键也落在这条上**（`undefined` 不是有限数）—— 缺键当 0，
 * 一个 NaN 都不许进状态。
 */
const clampTo = (k: keyof Adjustments, v: number): number => {
  const [lo, hi] = PARAM_RANGE[k]
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0
}

/** 把十五个字段各自钳到 `PARAM_RANGE` 里那一段。纯函数，不改入参。 */
export function clampAdjustments(a: Adjustments): Adjustments {
  return {
    exposure: clampTo('exposure', a.exposure),
    contrast: clampTo('contrast', a.contrast),
    highlights: clampTo('highlights', a.highlights),
    shadows: clampTo('shadows', a.shadows),
    saturation: clampTo('saturation', a.saturation),
    temperature: clampTo('temperature', a.temperature),
    clarity: clampTo('clarity', a.clarity),
    vignette: clampTo('vignette', a.vignette),
    vibrance: clampTo('vibrance', a.vibrance),
    cbCyanRed: clampTo('cbCyanRed', a.cbCyanRed),
    cbMagentaGreen: clampTo('cbMagentaGreen', a.cbMagentaGreen),
    cbYellowBlue: clampTo('cbYellowBlue', a.cbYellowBlue),
    splitHiHue: clampTo('splitHiHue', a.splitHiHue),
    splitLoHue: clampTo('splitLoHue', a.splitLoHue),
    splitAmount: clampTo('splitAmount', a.splitAmount),
  }
}

/**
 * 把增量叠加到当前值上，再整体钳制。
 *
 * 为什么用增量而不是绝对值：LLM 做算术是经典翻车点。
 * 让它说"再暖一点 = +20"，累加和钳制交给这里的确定性代码。
 */
export function applyDeltas(base: Adjustments, deltas: Partial<Adjustments>): Adjustments {
  const out = { ...base }
  for (const k of PARAM_KEYS) {
    const d = deltas[k]
    if (typeof d === 'number') out[k] = out[k] + d
  }
  return clampAdjustments(out)
}

/**
 * 换算成着色器 uniform 用的数值：一般参数除以 100（-1 ~ 1）；
 * 色相除以 360、强度除以 100 —— 这两类 0 在量程左端，出来是 0 ~ 1，不是 ±1。
 * 除数是**逐字段写死的**，不从 `PARAM_RANGE` 现算：现算的话，范围表哪天被改动，
 * 渲染的含义会跟着静默漂 —— 这里要的是改一个字就看得见。
 */
export function toUnit(a: Adjustments): Record<keyof Adjustments, number> {
  const c = clampAdjustments(a)
  return {
    exposure: c.exposure / PARAM_MAX,
    contrast: c.contrast / PARAM_MAX,
    highlights: c.highlights / PARAM_MAX,
    shadows: c.shadows / PARAM_MAX,
    saturation: c.saturation / PARAM_MAX,
    temperature: c.temperature / PARAM_MAX,
    clarity: c.clarity / PARAM_MAX,
    vignette: c.vignette / PARAM_MAX,
    vibrance: c.vibrance / PARAM_MAX,
    cbCyanRed: c.cbCyanRed / PARAM_MAX,
    cbMagentaGreen: c.cbMagentaGreen / PARAM_MAX,
    cbYellowBlue: c.cbYellowBlue / PARAM_MAX,
    // 色相：除以一圈
    splitHiHue: c.splitHiHue / 360,
    splitLoHue: c.splitLoHue / 360,
    splitAmount: c.splitAmount / PARAM_MAX,
  }
}
