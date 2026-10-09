import { MAX_DIMENSION, align32, fitWithin } from '../../shared/size.ts'
import { makeCanvas } from '../core/canvas'
import { blobToDataUrl } from './blob'

export type PreparedImage = {
  /** data URL。送后端用（后端再转发给生成模型）。 */
  dataUrl: string
  width: number
  height: number
}

/**
 * 能被 drawImage 画出来、又自带尺寸的东西。
 *
 * ⚠️ **`DecodedImage` 不是它**——那个是 `{ bitmap, width, height }` 的包装对象，
 * 得传 `.bitmap` 进去。（`ImageBitmap` 自己就带 width/height，所以包装里那两个
 * 字段是冗余的，但计划一的类型已经这么定了，不去动它。）
 */
export type Sizable = CanvasImageSource & { width: number; height: number }

/**
 * 把一张图备成能送模型的（spec §4.4）：长边缩到 maxDim、宽高各自对齐到
 * 32 的倍数、编成 JPEG。
 *
 * **画布尺寸必须按对齐后的尺寸设**，不是在原图上缩——align32 会把边长
 * 推最多 16px，差这几像素就会让上游 400。
 *
 * 做在浏览器端是因为这里已经有解码好的位图，不必让原始大图多跑一趟网络。
 */
export async function prepareForModel(
  source: Sizable,
  maxDim = MAX_DIMENSION,
): Promise<PreparedImage> {
  const fitted = fitWithin(source.width, source.height, maxDim)
  const width = align32(fitted.width)
  const height = align32(fitted.height)

  const { canvas, ctx } = makeCanvas(width, height, '备不出送模型的图')

  // 等比缩放 + 至多 16px 的轻微拉伸。肉眼不可见，换来宽高都是 32 的倍数。
  ctx.drawImage(source, 0, 0, width, height)

  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.9))
  if (!blob) throw new Error('图片编码失败')
  return { dataUrl: await blobToDataUrl(blob), width, height }
}

/**
 * 路由用的缩略预览。
 *
 * 路由**不需要**全分辨率——VLM 只是"看看这照片长什么样"。送小图省带宽、
 * 省 token、也更快。
 *
 * ★ 2026-09-30：**1024 → 640**。原来这段注释写着"这个尺寸没做过 A/B 实测，
 * 要动它之前先跑一次对比" —— 跑完了。探针留在
 * `.superpowers/scratch/audit/route_stream_probe.mjs`（量时间）
 * 和 `route_parse_probe.mjs`（量判断质量），两组独立测量指向同一个数：
 *
 * | 预览长边 | 首块到达（流式）中位数 | 整次调用中位数 |
 * |---|---|---|
 * | 1024 | 9.5s（n=12） | 11.1s（n=7） |
 * | **640** | **5.2s（n=11）** | **7.0s（n=7）** |
 *
 * 判断质量那一半：同一张照片 × 同一句话，两个尺寸各跑一遍，把模型原文喂给
 * **生产里那份 parseDecision**（不是我自己的 JSON.parse —— 第一版探针就是栽在
 * 这上面，把模型偶尔吐的标签格式当成了失败）。10 组对比里路由结论、`needs_disambiguation`、
 * `paramDeltas` 的量级都一致，差异全落在模型自己本来就有的抖动里。
 *
 * 为什么值得：路由在**产品生死线**上（30 秒发朋友圈），而它在关键路径上占 3~20 秒；
 * 少 4 秒、还少一截输入 token（route 按张计费）。而且这一步**可逆**：一行的事。
 *
 * ⚠️ 别再往下压到 512 就以为更省 —— 实测 512 那次反而出现 16.6 秒的离群值，
 * 样本太小看不出趋势。真要动，先按上面同一套方法再量一遍。
 */
export async function prepareForRouting(
  source: Sizable,
  maxDim = 640,
): Promise<PreparedImage> {
  return prepareForModel(source, maxDim)
}
