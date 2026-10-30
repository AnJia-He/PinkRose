/**
 * 九十四个参数（八十二个调色 + 两个几何透视 + 七个镜头虚化 + 三个镜头校正）。
 * **顺序 = `PARAM_KEYS` 的顺序 =
 * 面板显示顺序**。
 *
 * 老八根（exposure / contrast / highlights / shadows / saturation /
 * temperature / clarity / vignette）的字段名一个字没动；后面七条是
 * 2026-10-04「专业面板」加进来的（自然饱和度 / 色彩平衡三轴 / 分离色调）；
 * ★ 2026-10-17 磨皮（`skinSmooth`）追加在末尾 —— 效果组第三根，
 *   **追加而不是插队**，老用户对前两根的肌肉记忆不动（设计 2026-10-17-skin-smooth）。
 * ★ 2026-10-17 追加「细节」组：锐化 / 降噪 / 颗粒（设计 2026-10-17-detail-effects）。
 *   同样是**追加**：老参数的顺序和分组一个都不动。
 * ★ 2026-10-17 追加「HSL」组：8 条色带 × 色相/饱和度/明度（设计 2026-10-17-hsl）。
 * ★ 2026-10-17 追加「曲线」组：黑场 / 阴影 / 中间调 / 高光 / 白场（设计 2026-10-17-tone-curve）。
 * ★ 2026-10-17 追加「美颜」组：美白 / 红润（只作用于肤色区域）。
 * ★ 2026-10-17 追加「几何」组：垂直透视 / 水平透视（非破坏的梯形校正）。
 * ★ 2026-10-17 追加「镜头」组：虚化强度 / 清晰范围 / 过渡（径向景深虚化）。
 * ★ 2026-10-19 「镜头」组追加焦点 X / Y（可拖的虚化中心）。
 * ★ 2026-10-17 追加「镜头校正」组：畸变校正 / 色差校正（采样网格与通道位移）。
 * ★ 2026-10-17 追加「去雾」（`dehaze`）—— 效果组第四根，负值给画面加雾。
 * ★ 2026-10-18 追加「HDR」（`hdr`）—— 效果组第五根，局部提暗部 / 压高光。
 * ★ 2026-10-18 追加 RGB 分通道曲线（红 / 绿 / 蓝各五个控制点）。
 * ★ 2026-10-18 追加「柔光」（`glow`）—— 效果组第六根，让高光向周围溢出。
 * ★ 2026-10-19 追加白色色阶 / 黑色色阶（光效组）和纹理（细节组）。
 * ★ 2026-10-22 把分离色调补成三段色彩分级：中间调颜色 / 强度 + 明暗平衡。
 * ★ 2026-10-22 追加绿—洋红色调（`tint`），和色温组成完整白平衡两轴。
 * ★ 2026-10-22 追加黑白混色：黑白强度 + 红 / 绿 / 蓝通道权重。
 */
export type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  /** 白色色阶：只抬 / 压接近白场的一端，0 = 不动。 */
  whites: number
  /** 黑色色阶：只抬 / 压接近黑场的一端，0 = 不动。 */
  blacks: number
  temperature: number
  /** 绿—洋红色调：负值偏绿、正值偏洋红；0 = 不动。 */
  tint: number
  vibrance: number
  saturation: number
  /** 黑白强度，0~100；100 = 完全黑白。 */
  bwAmount: number
  /** 黑白混色的红 / 绿 / 蓝权重，-100~100；0 = 标准 Rec.709 亮度。 */
  bwRed: number
  bwGreen: number
  bwBlue: number
  cbCyanRed: number
  cbMagentaGreen: number
  cbYellowBlue: number
  splitHiHue: number
  splitLoHue: number
  splitAmount: number
  /** 中间调色相；`splitMidAmount` 为 0 时不影响画面。 */
  splitMidHue: number
  /** 中间调着色强度，0~100。 */
  splitMidAmount: number
  /** 三段分级的明暗平衡，-100 偏暗部、100 偏亮部，0 = 原权重。 */
  splitBalance: number
  clarity: number
  vignette: number
  skinSmooth: number
  /** 去雾，-100~100；0 = 不动。正值去雾、负值加雾。 */
  dehaze: number
  /** HDR，0~100；0 = 不动。局部提暗部、压高光。 */
  hdr: number
  /** 柔光 / 光晕，0~100；0 = 不动。只让高光向周围溢出。 */
  glow: number
  /** 纹理：中频细节，比清晰度更细、比锐化更柔，0 = 不动。 */
  texture: number
  sharpen: number
  /** 锐化采样半径，0~100；0 = 原有的 1px 邻域。 */
  sharpenRadius: number
  /** 边缘蒙版，0~100；越高越只锐化明显边缘，纯色区域越少被放大。 */
  sharpenMasking: number
  noiseReduction: number
  /** 彩色噪声抑制，0~100；只平滑色度斑点，尽量保留亮度纹理。 */
  colorNoiseReduction: number
  grain: number
  hslRedHue: number
  hslRedSat: number
  hslRedLum: number
  hslOrangeHue: number
  hslOrangeSat: number
  hslOrangeLum: number
  hslYellowHue: number
  hslYellowSat: number
  hslYellowLum: number
  hslGreenHue: number
  hslGreenSat: number
  hslGreenLum: number
  hslCyanHue: number
  hslCyanSat: number
  hslCyanLum: number
  hslBlueHue: number
  hslBlueSat: number
  hslBlueLum: number
  hslPurpleHue: number
  hslPurpleSat: number
  hslPurpleLum: number
  hslMagentaHue: number
  hslMagentaSat: number
  hslMagentaLum: number
  curveBlack: number
  curveShadows: number
  curveMidtones: number
  curveHighlights: number
  curveWhite: number
  curveRedBlack: number
  curveRedShadows: number
  curveRedMidtones: number
  curveRedHighlights: number
  curveRedWhite: number
  curveGreenBlack: number
  curveGreenShadows: number
  curveGreenMidtones: number
  curveGreenHighlights: number
  curveGreenWhite: number
  curveBlueBlack: number
  curveBlueShadows: number
  curveBlueMidtones: number
  curveBlueHighlights: number
  curveBlueWhite: number
  skinBrighten: number
  skinRosy: number
  /** 垂直透视校正，-100~100；0 = 不动。正值把上窄下宽拉正（见 shader）。 */
  perspectiveV: number
  /** 水平透视校正，-100~100；0 = 不动。正值把左窄右宽拉正。 */
  perspectiveH: number
  /** 镜头虚化强度，0~100；0 = 不虚化。 */
  lensBlur: number
  /** 中心清晰范围，-100~100；0 = 中等范围。 */
  lensRange: number
  /** 清晰到虚化的过渡，-100~100；0 = 中等过渡。 */
  lensFeather: number
  /** 虚化焦点位置，-100~100；0 = 画面中心。 */
  lensFocusX: number
  lensFocusY: number
  /** 虚化方式：0 = 径向；100 = 移轴清晰带。 */
  lensShape: number
  /** 移轴清晰带角度，-100~100；shader 内映射到 ±90°，0 = 水平带。 */
  lensAngle: number
  /** 径向畸变校正，-100~100；0 = 不校正。正负方向相反，四角自动缩放不留空边。 */
  lensDistortion: number
  /** 横向色差校正，-100~100；0 = 不校正。红 / 蓝通道沿径向反向微移。 */
  lensChromatic: number
  /** 镜头暗角校正，-100~100；0 = 不校正。正值把四角提亮（去暗角）。 */
  lensVignette: number
}

/**
 * HSL 的八条色带。`hue` 是色相环上的中心（0~1），`keys` 是
 * 色相 / 饱和度 / 明度三根轴。
 *
 * ⚠️ 面板上只同时显示**选中色带**的三根滑块；`PARAM_GROUPS` 里仍然列出全部
 * 24 个键，因为参数顺序、作品配方和会话落盘都靠它。`HslControls` 用这张表
 * 切色带，别在组件里另抄一份颜色/键名。
 */
export const HSL_BANDS = [
  { id: 'red', label: '红', hue: 0, keys: ['hslRedHue', 'hslRedSat', 'hslRedLum'] },
  { id: 'orange', label: '橙', hue: 30 / 360, keys: ['hslOrangeHue', 'hslOrangeSat', 'hslOrangeLum'] },
  { id: 'yellow', label: '黄', hue: 60 / 360, keys: ['hslYellowHue', 'hslYellowSat', 'hslYellowLum'] },
  { id: 'green', label: '绿', hue: 120 / 360, keys: ['hslGreenHue', 'hslGreenSat', 'hslGreenLum'] },
  { id: 'cyan', label: '青', hue: 180 / 360, keys: ['hslCyanHue', 'hslCyanSat', 'hslCyanLum'] },
  { id: 'blue', label: '蓝', hue: 240 / 360, keys: ['hslBlueHue', 'hslBlueSat', 'hslBlueLum'] },
  { id: 'purple', label: '紫', hue: 280 / 360, keys: ['hslPurpleHue', 'hslPurpleSat', 'hslPurpleLum'] },
  { id: 'magenta', label: '洋红', hue: 320 / 360, keys: ['hslMagentaHue', 'hslMagentaSat', 'hslMagentaLum'] },
] as const satisfies readonly {
  id: string
  label: string
  hue: number
  keys: readonly [keyof Adjustments, keyof Adjustments, keyof Adjustments]
}[]

/** 24 个 HSL 参数键，顺序 = 八条色带 × 色相 / 饱和度 / 明度。 */
export const HSL_KEYS = [
  'hslRedHue', 'hslRedSat', 'hslRedLum',
  'hslOrangeHue', 'hslOrangeSat', 'hslOrangeLum',
  'hslYellowHue', 'hslYellowSat', 'hslYellowLum',
  'hslGreenHue', 'hslGreenSat', 'hslGreenLum',
  'hslCyanHue', 'hslCyanSat', 'hslCyanLum',
  'hslBlueHue', 'hslBlueSat', 'hslBlueLum',
  'hslPurpleHue', 'hslPurpleSat', 'hslPurpleLum',
  'hslMagentaHue', 'hslMagentaSat', 'hslMagentaLum',
] as const

/** 影调曲线的五个控制点：黑场 / 阴影 / 中间调 / 高光 / 白场。 */
export const CURVE_KEYS = [
  'curveBlack', 'curveShadows', 'curveMidtones', 'curveHighlights', 'curveWhite',
] as const

/** RGB 分通道曲线的三条通道；`keys` 和整体曲线一样是五个控制点。 */
export const RGB_CURVE_CHANNELS = [
  {
    id: 'red', label: '红',
    keys: ['curveRedBlack', 'curveRedShadows', 'curveRedMidtones', 'curveRedHighlights', 'curveRedWhite'],
  },
  {
    id: 'green', label: '绿',
    keys: ['curveGreenBlack', 'curveGreenShadows', 'curveGreenMidtones', 'curveGreenHighlights', 'curveGreenWhite'],
  },
  {
    id: 'blue', label: '蓝',
    keys: ['curveBlueBlack', 'curveBlueShadows', 'curveBlueMidtones', 'curveBlueHighlights', 'curveBlueWhite'],
  },
] as const satisfies readonly {
  id: string
  label: string
  keys: readonly [keyof Adjustments, keyof Adjustments, keyof Adjustments, keyof Adjustments, keyof Adjustments]
}[]

/** 15 个 RGB 曲线参数键，顺序 = 红 / 绿 / 蓝 × 五个控制点。 */
export const RGB_CURVE_KEYS = [
  ...RGB_CURVE_CHANNELS[0].keys,
  ...RGB_CURVE_CHANNELS[1].keys,
  ...RGB_CURVE_CHANNELS[2].keys,
] as const

/** 美颜两项：美白 / 红润，都只作用在肤色区域。 */
export const SKIN_KEYS = ['skinBrighten', 'skinRosy'] as const

/**
 * 九十个参数的键，**顺序 = 面板显示顺序**（分组见 `PARAM_GROUPS`）。
 * ⚠️ 顺序有消费者：调色面板、作品详情页的"改过哪些"都按它出现。
 */
export const PARAM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'vibrance', 'saturation',
  'bwAmount', 'bwRed', 'bwGreen', 'bwBlue',
  'cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue',
  'splitHiHue', 'splitLoHue', 'splitAmount',
  'splitMidHue', 'splitMidAmount', 'splitBalance',
  'clarity', 'vignette', 'skinSmooth', 'dehaze', 'hdr', 'glow',
  'texture', 'sharpen', 'sharpenRadius', 'sharpenMasking',
  'noiseReduction', 'colorNoiseReduction', 'grain',
  ...HSL_KEYS,
  ...CURVE_KEYS,
  ...RGB_CURVE_KEYS,
  ...SKIN_KEYS,
  'perspectiveV', 'perspectiveH',
  'lensBlur', 'lensRange', 'lensFeather', 'lensFocusX', 'lensFocusY',
  'lensShape', 'lensAngle',
  'lensDistortion', 'lensChromatic', 'lensVignette',
] as const satisfies readonly (keyof Adjustments)[]

/**
 * 九十个参数在**界面上**叫什么。
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
  whites: '白色色阶',
  blacks: '黑色色阶',
  saturation: '饱和度',
  temperature: '色温',
  tint: '色调',
  bwAmount: '黑白强度',
  bwRed: '红色混色',
  bwGreen: '绿色混色',
  bwBlue: '蓝色混色',
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
  splitMidHue: '中间调颜色',
  splitMidAmount: '中间调强度',
  splitBalance: '明暗平衡',
  // ★ 2026-10-17：磨皮（设计 2026-10-17-skin-smooth）——
  //   「磨皮」就是用户嘴里的那个词，不另起"皮肤柔化"这种术语（文案规范：同一件
  //   东西一个名字，用户找的是"磨皮"这三个字）。提示词那份（server/prompt.ts）
  //   也用同一个词。
  skinSmooth: '磨皮',
  // ★ 2026-10-17（去雾）：正值把雾蒙蒙的画面拉开，负值给画面加一层空气感。
  dehaze: '去雾',
  // ★ 2026-10-18（HDR）：局部提暗部、压高光；加「光比」让名字仍是中文。
  hdr: 'HDR 光比',
  // ★ 2026-10-18（柔光）：高光向周围溢出，做梦幻 / 逆光。
  glow: '柔光',
  // ★ 2026-10-17（细节组）：三个都是用户能直接说出口的词。
  texture: '纹理',
  sharpen: '锐化',
  sharpenRadius: '锐化半径',
  sharpenMasking: '锐化蒙版',
  noiseReduction: '降噪',
  colorNoiseReduction: '彩色降噪',
  grain: '颗粒',
  // ★ 2026-10-17（HSL）：八条色带共用「色相 / 饱和度 / 明度」三根轴。
  hslRedHue: '红色 色相', hslRedSat: '红色 饱和度', hslRedLum: '红色 明度',
  hslOrangeHue: '橙色 色相', hslOrangeSat: '橙色 饱和度', hslOrangeLum: '橙色 明度',
  hslYellowHue: '黄色 色相', hslYellowSat: '黄色 饱和度', hslYellowLum: '黄色 明度',
  hslGreenHue: '绿色 色相', hslGreenSat: '绿色 饱和度', hslGreenLum: '绿色 明度',
  hslCyanHue: '青色 色相', hslCyanSat: '青色 饱和度', hslCyanLum: '青色 明度',
  hslBlueHue: '蓝色 色相', hslBlueSat: '蓝色 饱和度', hslBlueLum: '蓝色 明度',
  hslPurpleHue: '紫色 色相', hslPurpleSat: '紫色 饱和度', hslPurpleLum: '紫色 明度',
  hslMagentaHue: '洋红 色相', hslMagentaSat: '洋红 饱和度', hslMagentaLum: '洋红 明度',
  // ★ 2026-10-17（曲线）：五个控制点的读数名（避免和「阴影」重名）。
  curveBlack: '曲线 黑场', curveShadows: '曲线 阴影', curveMidtones: '曲线 中间调',
  curveHighlights: '曲线 高光', curveWhite: '曲线 白场',
  // ★ 2026-10-18（RGB 曲线）：每条通道的五个控制点，名字带通道名。
  curveRedBlack: '红色曲线 黑场', curveRedShadows: '红色曲线 阴影', curveRedMidtones: '红色曲线 中间调',
  curveRedHighlights: '红色曲线 高光', curveRedWhite: '红色曲线 白场',
  curveGreenBlack: '绿色曲线 黑场', curveGreenShadows: '绿色曲线 阴影', curveGreenMidtones: '绿色曲线 中间调',
  curveGreenHighlights: '绿色曲线 高光', curveGreenWhite: '绿色曲线 白场',
  curveBlueBlack: '蓝色曲线 黑场', curveBlueShadows: '蓝色曲线 阴影', curveBlueMidtones: '蓝色曲线 中间调',
  curveBlueHighlights: '蓝色曲线 高光', curveBlueWhite: '蓝色曲线 白场',
  // ★ 2026-10-17（美颜）：只作用在肤色区域。
  skinBrighten: '美白', skinRosy: '红润',
  // ★ 2026-10-17（几何）：滑动校正梯形，不裁一刀、不改底图。
  perspectiveV: '垂直透视', perspectiveH: '水平透视',
  lensBlur: '虚化强度', lensRange: '清晰范围', lensFeather: '过渡',
  lensFocusX: '焦点左右', lensFocusY: '焦点上下',
  lensShape: '移轴模式', lensAngle: '移轴角度',
  lensDistortion: '畸变校正', lensChromatic: '色差校正', lensVignette: '暗角校正',
}

/**
 * 每个参数的取值范围。**默认 -100~100，例外逐条写在这儿** ——
 * 面板滑块、clamp、数字输入框都从这里取，一处定义。
 * ⚠️ 加例外时想一遍：这个参数的"中立点"还是不是 0？（复零／`isChanged` 都按 0 算）
 */
export const PARAM_RANGE: Record<keyof Adjustments, readonly [number, number]> = {
  exposure: [-100, 100], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  whites: [-100, 100], blacks: [-100, 100],
  saturation: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
  bwAmount: [0, 100], bwRed: [-100, 100], bwGreen: [-100, 100], bwBlue: [-100, 100],
  clarity: [-100, 100], vignette: [-100, 100],
  vibrance: [-100, 100],
  cbCyanRed: [-100, 100], cbMagentaGreen: [-100, 100], cbYellowBlue: [-100, 100],
  splitHiHue: [0, 360], splitLoHue: [0, 360], splitAmount: [0, 100],
  splitMidHue: [0, 360], splitMidAmount: [0, 100], splitBalance: [-100, 100],
  // ★ 2026-10-17：磨皮只有正的 —— 0 = 没磨，100 = 磨满。中立点仍是 0
  //   （复零 / isChanged 按 0 算，规矩见本文件顶上的说明）。
  skinSmooth: [0, 100],
  // ★ 2026-10-17（去雾）：正负是两个相反方向，0 = 不动。
  dehaze: [-100, 100],
  // ★ 2026-10-18（HDR）：只有正的，0 = 不处理。
  hdr: [0, 100],
  // ★ 2026-10-18（柔光）：只有正的，0 = 不发光。
  glow: [0, 100],
  // ★ 2026-10-17（细节组）：三条都只有正的，0 = 没做。
  texture: [-100, 100],
  sharpen: [0, 100],
  sharpenRadius: [0, 100],
  sharpenMasking: [0, 100],
  noiseReduction: [0, 100],
  colorNoiseReduction: [0, 100],
  grain: [0, 100],
  // ★ 2026-10-17（HSL）：三根轴都以 0 为中点，负值反向、正值正向。
  hslRedHue: [-100, 100], hslRedSat: [-100, 100], hslRedLum: [-100, 100],
  hslOrangeHue: [-100, 100], hslOrangeSat: [-100, 100], hslOrangeLum: [-100, 100],
  hslYellowHue: [-100, 100], hslYellowSat: [-100, 100], hslYellowLum: [-100, 100],
  hslGreenHue: [-100, 100], hslGreenSat: [-100, 100], hslGreenLum: [-100, 100],
  hslCyanHue: [-100, 100], hslCyanSat: [-100, 100], hslCyanLum: [-100, 100],
  hslBlueHue: [-100, 100], hslBlueSat: [-100, 100], hslBlueLum: [-100, 100],
  hslPurpleHue: [-100, 100], hslPurpleSat: [-100, 100], hslPurpleLum: [-100, 100],
  hslMagentaHue: [-100, 100], hslMagentaSat: [-100, 100], hslMagentaLum: [-100, 100],
  // ★ 2026-10-17（曲线）：控制点纵向位移；黑场只许向上抬、白场只许向下压。
  curveBlack: [-100, 100], curveShadows: [-100, 100], curveMidtones: [-100, 100],
  curveHighlights: [-100, 100], curveWhite: [-100, 100],
  // ★ 2026-10-18（RGB 曲线）：和整体曲线同一条范围规则。
  curveRedBlack: [-100, 100], curveRedShadows: [-100, 100], curveRedMidtones: [-100, 100],
  curveRedHighlights: [-100, 100], curveRedWhite: [-100, 100],
  curveGreenBlack: [-100, 100], curveGreenShadows: [-100, 100], curveGreenMidtones: [-100, 100],
  curveGreenHighlights: [-100, 100], curveGreenWhite: [-100, 100],
  curveBlueBlack: [-100, 100], curveBlueShadows: [-100, 100], curveBlueMidtones: [-100, 100],
  curveBlueHighlights: [-100, 100], curveBlueWhite: [-100, 100],
  // ★ 2026-10-17（美颜）：两项都只有正的，0 = 没做。
  skinBrighten: [0, 100], skinRosy: [0, 100],
  // ★ 2026-10-17（几何）：以 0 为中点，正负是两个相反的梯形方向。
  perspectiveV: [-100, 100], perspectiveH: [-100, 100],
  // ★ 2026-10-17（镜头）：强度只有正的；范围和过渡以 0 为中点。
  lensBlur: [0, 100], lensRange: [-100, 100], lensFeather: [-100, 100],
  lensFocusX: [-100, 100], lensFocusY: [-100, 100],
  lensShape: [0, 100], lensAngle: [-100, 100],
  // ★ 2026-10-17（镜头校正）：正负是两个相反的校正方向，0 = 不校正。
  lensDistortion: [-100, 100], lensChromatic: [-100, 100], lensVignette: [-100, 100],
}

/** 面板上的分组（顺序就是显示顺序）。`id` 给界面认（比如色彩平衡那组里还要画色轮）。 */
export const PARAM_GROUPS: readonly {
  id: 'light' | 'color' | 'balance' | 'split' | 'effects' | 'detail' | 'hsl'
    | 'bw' | 'curve' | 'beauty' | 'geometry' | 'lens' | 'lensFix'
  title: string
  keys: readonly (keyof Adjustments)[]
}[] = [
  {
    id: 'light', title: '光效',
    keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  },
  { id: 'color', title: '色彩', keys: ['temperature', 'tint', 'vibrance', 'saturation'] },
  { id: 'bw', title: '黑白', keys: ['bwAmount', 'bwRed', 'bwGreen', 'bwBlue'] },
  { id: 'balance', title: '色彩平衡', keys: ['cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue'] },
  {
    id: 'split', title: '分离色调',
    keys: [
      'splitHiHue', 'splitLoHue', 'splitAmount',
      'splitMidHue', 'splitMidAmount', 'splitBalance',
    ],
  },
  // ★ 2026-10-17：磨皮追加在效果组**末尾**（不是插在清晰度和暗角中间）——
  //   老两根的位置不动。它和清晰度是同一族空间操作（邻域像素），只是方向相反，
  //   放在同一组里读得通。
  {
    id: 'effects', title: '效果',
    keys: ['clarity', 'vignette', 'skinSmooth', 'dehaze', 'hdr', 'glow'],
  },
  // ★ 2026-10-17（细节组）：放在效果之后 —— 老组的顺序一个都不动。
  {
    id: 'detail', title: '细节',
    keys: [
      'texture', 'sharpen', 'sharpenRadius', 'sharpenMasking',
      'noiseReduction', 'colorNoiseReduction', 'grain',
    ],
  },
  // ★ 2026-10-17（HSL）：八条色带的三根轴。面板只同时显示选中色带的三根，
  //   但这里列全 24 个键 —— 顺序、配方、落盘都靠这份清单。
  { id: 'hsl', title: 'HSL', keys: HSL_KEYS },
  // ★ 2026-10-17（曲线）：五个控制点，面板用 `ToneCurve` 拖点编辑器渲染。
  { id: 'curve', title: '曲线', keys: [...CURVE_KEYS, ...RGB_CURVE_KEYS] },
  // ★ 2026-10-17（美颜）：美白 / 红润，都只作用在肤色区域。
  { id: 'beauty', title: '美颜', keys: SKIN_KEYS },
  // ★ 2026-10-17（几何）：放在最后一组 —— 它改的是采样网格，不是颜色。
  { id: 'geometry', title: '几何', keys: ['perspectiveV', 'perspectiveH'] },
  // ★ 2026-10-17（镜头）：径向景深虚化，中心保持清晰。
  {
    id: 'lens', title: '镜头',
    keys: [
      'lensBlur', 'lensRange', 'lensFeather', 'lensFocusX', 'lensFocusY',
      'lensShape', 'lensAngle',
    ],
  },
  // ★ 2026-10-17（镜头校正）：和创意虚化分开 —— 这一组是修镜头本身的毛病。
  {
    id: 'lensFix', title: '镜头校正',
    keys: ['lensDistortion', 'lensChromatic', 'lensVignette'],
  },
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
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  saturation: 0, temperature: 0, tint: 0, clarity: 0, vignette: 0,
  // ★ 2026-10-04 新增的七条 —— 中立点也全是 0（色相 0 时强度也是 0，效果为零）
  vibrance: 0,
  bwAmount: 0, bwRed: 0, bwGreen: 0, bwBlue: 0,
  cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0,
  splitHiHue: 0, splitLoHue: 0, splitAmount: 0,
  splitMidHue: 0, splitMidAmount: 0, splitBalance: 0,
  // ★ 2026-10-17：磨皮的中立点也是 0（0 = 没磨）
  skinSmooth: 0,
  // ★ 2026-10-17（去雾）：0 = 不动；负值加雾
  dehaze: 0,
  // ★ 2026-10-18（HDR）：0 = 不处理
  hdr: 0,
  // ★ 2026-10-18（柔光）：0 = 不发光
  glow: 0,
  // ★ 2026-10-17（细节组）：0 = 不锐化 / 不降噪 / 不加颗粒
  texture: 0, sharpen: 0, sharpenRadius: 0, sharpenMasking: 0,
  noiseReduction: 0, colorNoiseReduction: 0, grain: 0,
  // ★ 2026-10-17（HSL）：0 = 这一条色带不偏色、不增减饱和、不改明度
  hslRedHue: 0, hslRedSat: 0, hslRedLum: 0,
  hslOrangeHue: 0, hslOrangeSat: 0, hslOrangeLum: 0,
  hslYellowHue: 0, hslYellowSat: 0, hslYellowLum: 0,
  hslGreenHue: 0, hslGreenSat: 0, hslGreenLum: 0,
  hslCyanHue: 0, hslCyanSat: 0, hslCyanLum: 0,
  hslBlueHue: 0, hslBlueSat: 0, hslBlueLum: 0,
  hslPurpleHue: 0, hslPurpleSat: 0, hslPurpleLum: 0,
  hslMagentaHue: 0, hslMagentaSat: 0, hslMagentaLum: 0,
  // ★ 2026-10-17（曲线）：0 = 五个点都落在对角线上
  curveBlack: 0, curveShadows: 0, curveMidtones: 0, curveHighlights: 0, curveWhite: 0,
  // ★ 2026-10-18（RGB 曲线）：三条通道都落在对角线上
  curveRedBlack: 0, curveRedShadows: 0, curveRedMidtones: 0, curveRedHighlights: 0, curveRedWhite: 0,
  curveGreenBlack: 0, curveGreenShadows: 0, curveGreenMidtones: 0, curveGreenHighlights: 0, curveGreenWhite: 0,
  curveBlueBlack: 0, curveBlueShadows: 0, curveBlueMidtones: 0, curveBlueHighlights: 0, curveBlueWhite: 0,
  // ★ 2026-10-17（美颜）：0 = 不提亮 / 不加红润
  skinBrighten: 0, skinRosy: 0,
  // ★ 2026-10-17（几何）：0 = 不校正
  perspectiveV: 0, perspectiveH: 0,
  // ★ 2026-10-17（镜头）：0 = 不虚化；范围和过渡的 0 是中等值
  lensBlur: 0, lensRange: 0, lensFeather: 0, lensFocusX: 0, lensFocusY: 0,
  lensShape: 0, lensAngle: 0,
  // ★ 2026-10-17（镜头校正）：0 = 不校正
  lensDistortion: 0, lensChromatic: 0, lensVignette: 0,
})

/**
 * 预设强度：从 `base` 到 `target` 按百分比线性混合。
 *
 * 0 = 完全不动，100 = 目标预设原值。所有参数走同一张 `PARAM_KEYS`，
 * 以后新增参数不会因为这里漏写而悄悄不跟着强度变化。
 */
export function blendAdjustments(
  base: Adjustments, target: Adjustments, amount: number,
): Adjustments {
  const t = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount / 100 : 0))
  const out = {} as Adjustments
  for (const key of PARAM_KEYS) {
    out[key] = Math.round(base[key] + (target[key] - base[key]) * t)
  }
  return out
}

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
 * ⚠️ 判的是**相对中立值**，不是"和上一次比"。九十个参数都是"0 = 什么都没做"
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

/** 把九十个字段各自钳到 `PARAM_RANGE` 里那一段。纯函数，不改入参。 */
export function clampAdjustments(a: Adjustments): Adjustments {
  return {
    exposure: clampTo('exposure', a.exposure),
    contrast: clampTo('contrast', a.contrast),
    highlights: clampTo('highlights', a.highlights),
    shadows: clampTo('shadows', a.shadows),
    whites: clampTo('whites', a.whites),
    blacks: clampTo('blacks', a.blacks),
    saturation: clampTo('saturation', a.saturation),
    bwAmount: clampTo('bwAmount', a.bwAmount),
    bwRed: clampTo('bwRed', a.bwRed),
    bwGreen: clampTo('bwGreen', a.bwGreen),
    bwBlue: clampTo('bwBlue', a.bwBlue),
    temperature: clampTo('temperature', a.temperature),
    tint: clampTo('tint', a.tint),
    clarity: clampTo('clarity', a.clarity),
    vignette: clampTo('vignette', a.vignette),
    vibrance: clampTo('vibrance', a.vibrance),
    cbCyanRed: clampTo('cbCyanRed', a.cbCyanRed),
    cbMagentaGreen: clampTo('cbMagentaGreen', a.cbMagentaGreen),
    cbYellowBlue: clampTo('cbYellowBlue', a.cbYellowBlue),
    splitHiHue: clampTo('splitHiHue', a.splitHiHue),
    splitLoHue: clampTo('splitLoHue', a.splitLoHue),
    splitAmount: clampTo('splitAmount', a.splitAmount),
    splitMidHue: clampTo('splitMidHue', a.splitMidHue),
    splitMidAmount: clampTo('splitMidAmount', a.splitMidAmount),
    splitBalance: clampTo('splitBalance', a.splitBalance),
    skinSmooth: clampTo('skinSmooth', a.skinSmooth),
    dehaze: clampTo('dehaze', a.dehaze),
    hdr: clampTo('hdr', a.hdr),
    glow: clampTo('glow', a.glow),
    texture: clampTo('texture', a.texture),
    sharpen: clampTo('sharpen', a.sharpen),
    sharpenRadius: clampTo('sharpenRadius', a.sharpenRadius),
    sharpenMasking: clampTo('sharpenMasking', a.sharpenMasking),
    noiseReduction: clampTo('noiseReduction', a.noiseReduction),
    colorNoiseReduction: clampTo('colorNoiseReduction', a.colorNoiseReduction),
    grain: clampTo('grain', a.grain),
    hslRedHue: clampTo('hslRedHue', a.hslRedHue),
    hslRedSat: clampTo('hslRedSat', a.hslRedSat),
    hslRedLum: clampTo('hslRedLum', a.hslRedLum),
    hslOrangeHue: clampTo('hslOrangeHue', a.hslOrangeHue),
    hslOrangeSat: clampTo('hslOrangeSat', a.hslOrangeSat),
    hslOrangeLum: clampTo('hslOrangeLum', a.hslOrangeLum),
    hslYellowHue: clampTo('hslYellowHue', a.hslYellowHue),
    hslYellowSat: clampTo('hslYellowSat', a.hslYellowSat),
    hslYellowLum: clampTo('hslYellowLum', a.hslYellowLum),
    hslGreenHue: clampTo('hslGreenHue', a.hslGreenHue),
    hslGreenSat: clampTo('hslGreenSat', a.hslGreenSat),
    hslGreenLum: clampTo('hslGreenLum', a.hslGreenLum),
    hslCyanHue: clampTo('hslCyanHue', a.hslCyanHue),
    hslCyanSat: clampTo('hslCyanSat', a.hslCyanSat),
    hslCyanLum: clampTo('hslCyanLum', a.hslCyanLum),
    hslBlueHue: clampTo('hslBlueHue', a.hslBlueHue),
    hslBlueSat: clampTo('hslBlueSat', a.hslBlueSat),
    hslBlueLum: clampTo('hslBlueLum', a.hslBlueLum),
    hslPurpleHue: clampTo('hslPurpleHue', a.hslPurpleHue),
    hslPurpleSat: clampTo('hslPurpleSat', a.hslPurpleSat),
    hslPurpleLum: clampTo('hslPurpleLum', a.hslPurpleLum),
    hslMagentaHue: clampTo('hslMagentaHue', a.hslMagentaHue),
    hslMagentaSat: clampTo('hslMagentaSat', a.hslMagentaSat),
    hslMagentaLum: clampTo('hslMagentaLum', a.hslMagentaLum),
    curveBlack: clampTo('curveBlack', a.curveBlack),
    curveShadows: clampTo('curveShadows', a.curveShadows),
    curveMidtones: clampTo('curveMidtones', a.curveMidtones),
    curveHighlights: clampTo('curveHighlights', a.curveHighlights),
    curveWhite: clampTo('curveWhite', a.curveWhite),
    curveRedBlack: clampTo('curveRedBlack', a.curveRedBlack),
    curveRedShadows: clampTo('curveRedShadows', a.curveRedShadows),
    curveRedMidtones: clampTo('curveRedMidtones', a.curveRedMidtones),
    curveRedHighlights: clampTo('curveRedHighlights', a.curveRedHighlights),
    curveRedWhite: clampTo('curveRedWhite', a.curveRedWhite),
    curveGreenBlack: clampTo('curveGreenBlack', a.curveGreenBlack),
    curveGreenShadows: clampTo('curveGreenShadows', a.curveGreenShadows),
    curveGreenMidtones: clampTo('curveGreenMidtones', a.curveGreenMidtones),
    curveGreenHighlights: clampTo('curveGreenHighlights', a.curveGreenHighlights),
    curveGreenWhite: clampTo('curveGreenWhite', a.curveGreenWhite),
    curveBlueBlack: clampTo('curveBlueBlack', a.curveBlueBlack),
    curveBlueShadows: clampTo('curveBlueShadows', a.curveBlueShadows),
    curveBlueMidtones: clampTo('curveBlueMidtones', a.curveBlueMidtones),
    curveBlueHighlights: clampTo('curveBlueHighlights', a.curveBlueHighlights),
    curveBlueWhite: clampTo('curveBlueWhite', a.curveBlueWhite),
    skinBrighten: clampTo('skinBrighten', a.skinBrighten),
    skinRosy: clampTo('skinRosy', a.skinRosy),
    perspectiveV: clampTo('perspectiveV', a.perspectiveV),
    perspectiveH: clampTo('perspectiveH', a.perspectiveH),
    lensBlur: clampTo('lensBlur', a.lensBlur),
    lensRange: clampTo('lensRange', a.lensRange),
    lensFeather: clampTo('lensFeather', a.lensFeather),
    lensFocusX: clampTo('lensFocusX', a.lensFocusX),
    lensFocusY: clampTo('lensFocusY', a.lensFocusY),
    lensShape: clampTo('lensShape', a.lensShape),
    lensAngle: clampTo('lensAngle', a.lensAngle),
    lensDistortion: clampTo('lensDistortion', a.lensDistortion),
    lensChromatic: clampTo('lensChromatic', a.lensChromatic),
    lensVignette: clampTo('lensVignette', a.lensVignette),
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
    whites: c.whites / PARAM_MAX,
    blacks: c.blacks / PARAM_MAX,
    saturation: c.saturation / PARAM_MAX,
    bwAmount: c.bwAmount / PARAM_MAX,
    bwRed: c.bwRed / PARAM_MAX,
    bwGreen: c.bwGreen / PARAM_MAX,
    bwBlue: c.bwBlue / PARAM_MAX,
    temperature: c.temperature / PARAM_MAX,
    tint: c.tint / PARAM_MAX,
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
    splitMidHue: c.splitMidHue / 360,
    splitMidAmount: c.splitMidAmount / PARAM_MAX,
    splitBalance: c.splitBalance / PARAM_MAX,
    skinSmooth: c.skinSmooth / PARAM_MAX,
    dehaze: c.dehaze / PARAM_MAX,
    hdr: c.hdr / PARAM_MAX,
    glow: c.glow / PARAM_MAX,
    texture: c.texture / PARAM_MAX,
    sharpen: c.sharpen / PARAM_MAX,
    sharpenRadius: c.sharpenRadius / PARAM_MAX,
    sharpenMasking: c.sharpenMasking / PARAM_MAX,
    noiseReduction: c.noiseReduction / PARAM_MAX,
    colorNoiseReduction: c.colorNoiseReduction / PARAM_MAX,
    grain: c.grain / PARAM_MAX,
    hslRedHue: c.hslRedHue / PARAM_MAX,
    hslRedSat: c.hslRedSat / PARAM_MAX,
    hslRedLum: c.hslRedLum / PARAM_MAX,
    hslOrangeHue: c.hslOrangeHue / PARAM_MAX,
    hslOrangeSat: c.hslOrangeSat / PARAM_MAX,
    hslOrangeLum: c.hslOrangeLum / PARAM_MAX,
    hslYellowHue: c.hslYellowHue / PARAM_MAX,
    hslYellowSat: c.hslYellowSat / PARAM_MAX,
    hslYellowLum: c.hslYellowLum / PARAM_MAX,
    hslGreenHue: c.hslGreenHue / PARAM_MAX,
    hslGreenSat: c.hslGreenSat / PARAM_MAX,
    hslGreenLum: c.hslGreenLum / PARAM_MAX,
    hslCyanHue: c.hslCyanHue / PARAM_MAX,
    hslCyanSat: c.hslCyanSat / PARAM_MAX,
    hslCyanLum: c.hslCyanLum / PARAM_MAX,
    hslBlueHue: c.hslBlueHue / PARAM_MAX,
    hslBlueSat: c.hslBlueSat / PARAM_MAX,
    hslBlueLum: c.hslBlueLum / PARAM_MAX,
    hslPurpleHue: c.hslPurpleHue / PARAM_MAX,
    hslPurpleSat: c.hslPurpleSat / PARAM_MAX,
    hslPurpleLum: c.hslPurpleLum / PARAM_MAX,
    hslMagentaHue: c.hslMagentaHue / PARAM_MAX,
    hslMagentaSat: c.hslMagentaSat / PARAM_MAX,
    hslMagentaLum: c.hslMagentaLum / PARAM_MAX,
    curveBlack: c.curveBlack / PARAM_MAX,
    curveShadows: c.curveShadows / PARAM_MAX,
    curveMidtones: c.curveMidtones / PARAM_MAX,
    curveHighlights: c.curveHighlights / PARAM_MAX,
    curveWhite: c.curveWhite / PARAM_MAX,
    curveRedBlack: c.curveRedBlack / PARAM_MAX,
    curveRedShadows: c.curveRedShadows / PARAM_MAX,
    curveRedMidtones: c.curveRedMidtones / PARAM_MAX,
    curveRedHighlights: c.curveRedHighlights / PARAM_MAX,
    curveRedWhite: c.curveRedWhite / PARAM_MAX,
    curveGreenBlack: c.curveGreenBlack / PARAM_MAX,
    curveGreenShadows: c.curveGreenShadows / PARAM_MAX,
    curveGreenMidtones: c.curveGreenMidtones / PARAM_MAX,
    curveGreenHighlights: c.curveGreenHighlights / PARAM_MAX,
    curveGreenWhite: c.curveGreenWhite / PARAM_MAX,
    curveBlueBlack: c.curveBlueBlack / PARAM_MAX,
    curveBlueShadows: c.curveBlueShadows / PARAM_MAX,
    curveBlueMidtones: c.curveBlueMidtones / PARAM_MAX,
    curveBlueHighlights: c.curveBlueHighlights / PARAM_MAX,
    curveBlueWhite: c.curveBlueWhite / PARAM_MAX,
    skinBrighten: c.skinBrighten / PARAM_MAX,
    skinRosy: c.skinRosy / PARAM_MAX,
    // 透视也是 ±100 → ±1；shader 内部再乘一个安全系数。
    perspectiveV: c.perspectiveV / PARAM_MAX,
    perspectiveH: c.perspectiveH / PARAM_MAX,
    lensBlur: c.lensBlur / PARAM_MAX,
    lensRange: c.lensRange / PARAM_MAX,
    lensFeather: c.lensFeather / PARAM_MAX,
    lensFocusX: c.lensFocusX / PARAM_MAX,
    lensFocusY: c.lensFocusY / PARAM_MAX,
    lensShape: c.lensShape / PARAM_MAX,
    lensAngle: c.lensAngle / PARAM_MAX,
    lensDistortion: c.lensDistortion / PARAM_MAX,
    lensChromatic: c.lensChromatic / PARAM_MAX,
    lensVignette: c.lensVignette / PARAM_MAX,
  }
}
