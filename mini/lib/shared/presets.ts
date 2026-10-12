// ⚠️ 自动生成 —— 勿改。改源头（scripts/sync-mini-shared.mjs 的 FILES 表）后重跑脚本。
import { ZERO, PARAM_KEYS, type Adjustments } from './adjustments'

export type Preset = {
  id: string
  label: string
  adjustments: Adjustments
}

/**
 * 一键风格 = 一组预设好的八参数值。
 * 不需要单独的引擎——应用预设就是把这组值直接赋给 params。
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'jp-clean',
    label: '日系通透',
    adjustments: { ...ZERO, exposure: 8, contrast: -6, shadows: 22, saturation: -12, temperature: -14, clarity: 8 },
  },
  {
    id: 'film',
    label: '胶片',
    adjustments: { ...ZERO, exposure: -4, contrast: -14, highlights: -18, shadows: 18, saturation: -18, temperature: 8, clarity: -10, vignette: 18 },
  },
  {
    id: 'golden',
    label: '黄昏',
    adjustments: { ...ZERO, exposure: 4, contrast: 12, highlights: -10, shadows: 10, saturation: 14, temperature: 32, clarity: 6, vignette: 12 },
  },
  {
    id: 'bright',
    label: '通透提亮',
    adjustments: { ...ZERO, exposure: 16, contrast: 8, highlights: -20, shadows: 26, saturation: 6, clarity: 14 },
  },
  {
    id: 'moody',
    label: '暗调氛围',
    adjustments: { ...ZERO, exposure: -10, contrast: 20, highlights: -24, shadows: -12, saturation: -10, temperature: -10, vignette: 30 },
  },
  {
    id: 'vivid',
    label: '鲜艳',
    adjustments: { ...ZERO, contrast: 14, saturation: 28, clarity: 16, vignette: 8 },
  },
  // ── ★ 2026-10-05：为了让照片左边那条「预设栏」有东西可摆，补的六个 ──────────
  // 名字挑的是旅拍里最常被点的几种。**后四个用上了 10-04 那批"专业面板"参数**
  // （色彩平衡 / 分离色调）—— 光靠老八根拼不出"青橙"和"复古"那种电影感。
  // ⚠️ 每个都是 `{...ZERO, …}` 的长拷贝，所以**没写到的参数一律归零**（老八根
  //    那六个也是这么个道理，见 AdjustmentPanel 里"套预设 = 新参数一并归零"那段）。
  {
    id: 'bw',
    label: '黑白',
    // 饱和度 -100 在 shader 里正好是 `sat = 0`（朝灰点插值到 0）= 真灰，
    // 不是"接近灰"；对比度/清晰度提一档，否则纯灰会显得平。
    adjustments: { ...ZERO, contrast: 18, highlights: -14, shadows: 8, saturation: -100, clarity: 22, vignette: 10 },
  },
  {
    id: 'teal-orange',
    label: '青橙',
    // 电影调色那套：亮部偏橙（32°）、暗部偏青（195°），靠分离色调做，
    // 不碰色彩平衡三轴 —— 三轴是整体偏色，做不出"两头往两个方向走"。
    adjustments: { ...ZERO, contrast: 12, shadows: 6, vibrance: 12, splitHiHue: 32, splitLoHue: 195, splitAmount: 42 },
  },
  {
    id: 'cream',
    label: '奶油',
    // 柔、亮、低反差：对比度往负走、清晰度也收（"软"要两处一起做）。
    adjustments: { ...ZERO, exposure: 6, contrast: -14, highlights: 10, shadows: 24, temperature: 8, vibrance: 14, saturation: -10, clarity: -16 },
  },
  {
    id: 'cool',
    label: '冷调',
    adjustments: { ...ZERO, exposure: 2, contrast: 10, highlights: -8, shadows: 10, temperature: -32, vibrance: 8, clarity: 8, vignette: 8 },
  },
  {
    id: 'retro',
    label: '复古',
    // 褪色胶片：压低饱和、抬黑位（阴影 +）、暖黄两头（44° / 96°）+ 暗角。
    adjustments: { ...ZERO, contrast: -16, highlights: -12, shadows: 26, temperature: 16, saturation: -20, splitHiHue: 44, splitLoHue: 96, splitAmount: 26, clarity: -8, vignette: 24 },
  },
  {
    id: 'crisp',
    label: '硬朗',
    // 风光那一路：反差 + 清晰度拉满，别用饱和度（会糊成一片），用自然饱和度。
    adjustments: { ...ZERO, exposure: 4, contrast: 24, highlights: -18, shadows: -10, vibrance: 20, clarity: 32, vignette: 12 },
  },
]

/**
 * 「原图」那一格（★ 2026-10-05）。**它不是预设** —— 是"什么都没做"
 * （参数全零 + 没挂滤镜），但它和预设挤在同一排里，所以需要一个自己的 id，
 * 让 `activePresetId` 报得出来"亮的是它"。
 *
 * ⚠️ 值 `'original'` 不许和任何一个预设 id 撞：撞了的话那一格永远点不亮
 * （`activePresetId` 先判全零，先返回的就是它）。
 */
export const ORIGINAL_ID = 'original'

/**
 * 现在"正套着"哪一个 —— 预设栏靠它点亮那一格。
 *
 * 三条判据，顺序有讲究：
 *   ① **挂着滤镜时谁都不算**（回 null，「原图」也不亮）—— 那时候画面是
 *      "预设 + 滤镜"，亮着任何一格都是半句真话。摘掉滤镜它会自己亮回来
 *      （参数一个字没动）；
 *   ② 参数全零 = 「原图」；
 *   ③ 否则找**全等**的那一个。用户拖过任何一根滑块之后就不该再亮着 ——
 *      那一眼看到的东西已经不是那个预设了，所以这里没有"接近"这回事
 *      （判全等而不是判某几根，是因为预设本来就是"整组赋值"，见
 *      `AdjustmentPanel` 里那段"套预设 = 新参数一并归零"）。
 *
 * ★ 2026-10-10（「我的预设」）：第三个参数 `mine` = 用户自己存的那一份清单
 *   （预设栏第二段）。判据一个字没变，只是**找的范围**从"内置那十二个"扩成
 *   "内置 + 我的" —— 两段共用这一份，点完谁亮不需要第二条路。
 *
 * ⚠️ **id 空间的约定**：内置 id 全是非纯数字串（`'golden'` 这种），服务端预设
 *   的数字 id 拼进来时一律 `String(id)` —— 两边永远不会撞（`presets.test.ts`
 *   有一条「内置 id 全是非纯数字」的测试守着这个前提）。默认值 `[]` 保住旧调用。
 */
export function activePresetId(
  a: Adjustments, lutOn: boolean, mine: readonly Preset[] = [],
): string | null {
  if (lutOn) return null
  if (PARAM_KEYS.every(k => a[k] === 0)) return ORIGINAL_ID
  return [...PRESETS, ...mine].find(p => PARAM_KEYS.every(k => p.adjustments[k] === a[k]))?.id ?? null
}
