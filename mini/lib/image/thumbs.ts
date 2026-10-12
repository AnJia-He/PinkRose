import { ZERO, type Adjustments } from '../shared/adjustments'
import { ORIGINAL_ID, type Preset } from '../shared/presets'
import type { CanvasNode, TonePipeline } from '../gl/tonePipeline'
import { putPixelsFlipped } from './pixels'

/**
 * 风格栏那一排效果小图 —— **用真渲染管线画出来的**，不是 CSS 滤镜近似
 * （电脑版为「小图和大图不一致」追过三次，`usePresetThumbs` 是同一个教训）。
 *
 * 画法：**借主画布**。把 GL 画布的 buffer 临时 resize 到「照片等比缩到高 128」，
 * 对每一格（原图 + 每个预设）render 一帧、readPixels 读回来、贴进一张**离屏 2D
 * 拼图画布**；十几格全画完，`wx.canvasToTempFilePath` **一次**导出成一张 sprite 图，
 * 页面用 `background-position` 切格显示（一格一个 canvas 节点在小程序里会卡 ——
 * 拼一张是 spec §4.2 定下的做法）。
 *
 * 三条契约（都和电脑版对齐，别只改一边）：
 *   ① **缩略图只依赖「照片 × 预设」**，与当前参数无关 —— 照片载入时画一次就够，
 *      点风格**不**重画这一排（电脑版 `usePresetThumbs` 的依赖里故意没有 params）。
 *      v1 没有滤镜，所以也没画「当前滤镜」那层（Lut 来了要在循环前补一次 setLut）。
 *   ② 每格画的是「**点下去会发生什么**」：那一格自己的参数整组赋值后的样子
 *      （「原图」格 = 全零那一帧，正好是"点它会得到什么"）。
 *   ③ 借完要**还**：buffer 回照片原尺寸 + 用当前参数重画一帧，且这两步在
 *      **导出之前**做完 —— 导出要等，等的时候屏幕上不能挂着最后那张小图被拉大。
 *
 * ## 尺寸约定（⚠️ 两组数字同一个值、两个单位，别混）
 *   · 渲染高 = `RENDER_H` = 128 **物理 px**（brief 的「高 128」）；
 *   · 显示高 = index.wxss 里 `.styles` 的 `--thumb-h: 128rpx`。
 *   375 宽的屏上 128rpx = 64px，正好是渲染高的一半 —— 2x/3x 屏够糊弄。
 *   每格宽 = `round(照片宽高比 × RENDER_H)`，这一个数**同时**当两用：
 *     · sprite 里的渲染坐标（px）；
 *     · wxml 里该格的显示值（rpx）。
 *   横图格子宽、竖图窄，比例原样保着（横滑本来就支持）。
 */

/** 一格的视图数据：id/名字 + 在 sprite 里的位置。x/w 见文件头「尺寸约定」。 */
export interface ThumbCell {
  id: string
  label: string
  /** 左边框在 sprite 里的位置（= 前面所有格宽度之和），wxml 里 `background-position: -x rpx` */
  x: number
  /** 这一格的宽度（= sprite 切片宽，wxml 里该格的 width 也是它） */
  w: number
}

export interface ThumbSprite {
  /** sprite 的临时文件路径（wxml 里 `background-image: url(...)` 用） */
  path: string
  cells: ThumbCell[]
}

/** 小图的**渲染**高度（物理 px）—— 和显示高度（`--thumb-h`，rpx）是两个单位，见文件头 */
const RENDER_H = 128

/** 「原图」那一格的显示名（电脑版 PresetGrid 里同一个词：先有一个"什么都不要"的出口） */
const ORIGINAL_LABEL = '原图'

/** 格子宽的下限 —— 只防刀把形的图（宽高比趋近 0）算出 0 宽，正常照片碰不到 */
const MIN_CELL_W = 8

/**
 * 画整条风格栏的缩略图（原图 + 传进来的预设，打头是原图）。
 *
 * @param node    GL 画布节点（借它 resize buffer —— 管线的 node 是私有的，所以单传）
 * @param pipe    渲染管线（照片已经在里面了；这里只 render/readPixels，不 setImage）
 * @param img     加载好的照片（只要宽高，算格子等比宽用）
 * @param presets 预设清单（页面传共享 `PRESETS`；「原图」由本函数自己打头）
 * @param restore 画完把屏幕还回哪一帧 = **调用那一刻的当前参数**（不传则全零）
 */
export async function renderThumbSprite(
  node: CanvasNode,
  pipe: TonePipeline,
  img: WechatMiniprogram.Image,
  presets: readonly Preset[],
  restore: Adjustments = ZERO,
): Promise<ThumbSprite> {
  // 「原图」不是预设（见共享 presets.ts 的注释），但它在这排里占一格 ——
  // 这里补上它的"参数"（全零）和名字，后面每一格的画法就完全一样了。
  const entries: readonly { id: string; label: string; adjustments: Adjustments }[] = [
    { id: ORIGINAL_ID, label: ORIGINAL_LABEL, adjustments: ZERO },
    ...presets,
  ]

  // ① 先把格子算出来（纯算术，不碰 GL）。
  const aspect = img.width / img.height
  let x = 0
  const cells: ThumbCell[] = entries.map(e => {
    const w = Math.max(MIN_CELL_W, Math.round(aspect * RENDER_H))
    const cell = { id: e.id, label: e.label, x, w }
    x += w
    return cell
  })
  const spriteW = x

  const sprite = wx.createOffscreenCanvas({ type: '2d', width: spriteW, height: RENDER_H })
  const ctx = sprite.getContext('2d')

  // ② 借主画布画十几帧。★ 整段**同步**跑完 —— 中间那些"画布变成小图"的帧
  //    用户一帧都看不到（合成器只在 JS 把控制权让出去之后才有机会上屏）。
  try {
    for (let i = 0; i < entries.length; i++) {
      node.width = cells[i].w
      node.height = RENDER_H
      pipe.render(entries[i].adjustments)
      // GL 读回来的行序自下而上 —— 翻行的规矩只有一份，在 lib/image/pixels.ts
      putPixelsFlipped(ctx, pipe.readPixels(), cells[i].w, RENDER_H, cells[i].x, 0)
    }
  } finally {
    // ③ 还给屏幕：buffer 回照片原尺寸 + 用当前参数重画一帧。
    //    ⚠️ 放在 finally 里是有意的：中间任何一格画炸了，屏幕也得是好的
    //    （留在"小图被拉大"的样子比报错本身更吓人）。
    pipe.resizeToImage()
    pipe.render(restore)
  }

  const path = await exportSprite(sprite, spriteW, RENDER_H)
  return { path, cells }
}

/** 拼图 → 临时文件（png）。导出的是**整张 sprite**，格子靠 background-position 切。 */
function exportSprite(
  canvas: WechatMiniprogram.IAnyObject, w: number, h: number,
): Promise<string> {
  return new Promise((ok, no) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: w,
      height: h,
      destWidth: w,
      destHeight: h,
      fileType: 'png',
      success: r => ok(r.tempFilePath),
      fail: e => no(new Error('风格缩略图导出失败：' + ((e && e.errMsg) || '未知原因'))),
    })
  })
}
