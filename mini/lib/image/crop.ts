export type CropRatio = 'original' | '1:1' | '4:5' | '3:4' | '16:9'

const RATIO: Record<Exclude<CropRatio, 'original'>, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
}

/** 最大居中裁剪框；所有边界都夹在源尺寸内。 */
export function cropRect(
  width: number,
  height: number,
  ratio: CropRatio,
): { x: number; y: number; w: number; h: number } {
  const safeW = Math.max(1, Math.round(width))
  const safeH = Math.max(1, Math.round(height))
  if (ratio === 'original') return { x: 0, y: 0, w: safeW, h: safeH }
  const target = RATIO[ratio]
  let w = safeW
  let h = safeH
  if (safeW / safeH > target) w = Math.round(safeH * target)
  else h = Math.round(safeW / target)
  w = Math.max(1, Math.min(safeW, w))
  h = Math.max(1, Math.min(safeH, h))
  return {
    x: Math.max(0, Math.floor((safeW - w) / 2)),
    y: Math.max(0, Math.floor((safeH - h) / 2)),
    w,
    h,
  }
}

export function rotateSize(
  width: number,
  height: number,
  quarterTurns: number,
): { width: number; height: number } {
  const turns = ((Math.round(quarterTurns) % 4) + 4) % 4
  return turns % 2 === 1 ? { width: height, height: width } : { width, height }
}

export type CropInput = {
  sourcePath: string
  width: number
  height: number
  ratio: CropRatio
  quarterTurns: number
  flipH: boolean
}

function imageOn(
  canvas: WechatMiniprogram.Canvas | WechatMiniprogram.OffscreenCanvas,
  src: string,
): Promise<WechatMiniprogram.Image> {
  return new Promise((ok, no) => {
    const img = canvas.createImage()
    img.onload = () => ok(img)
    img.onerror = () => no(new Error('裁剪时读不到当前照片'))
    img.src = src
  })
}

function canvasToJpg(
  canvas: WechatMiniprogram.Canvas | WechatMiniprogram.OffscreenCanvas,
): Promise<string> {
  return new Promise((ok, no) => {
    wx.canvasToTempFilePath({
      canvas: canvas as WechatMiniprogram.Canvas,
      fileType: 'jpg',
      quality: 0.95,
      success: res => res.tempFilePath
        ? ok(res.tempFilePath)
        : no(new Error('裁剪结果给了空文件路径')),
      fail: e => no(new Error('裁剪结果存不下来：' + String((e && e.errMsg) || e))),
    })
  })
}

/** 旋转、翻转、居中裁剪，输出新的 JPG 底图；不改当前表格里的任何参数。 */
export async function cropToFile(input: CropInput): Promise<{
  path: string
  width: number
  height: number
}> {
  const turns = ((Math.round(input.quarterTurns) % 4) + 4) % 4
  const rotated = rotateSize(input.width, input.height, turns)
  const full = wx.createOffscreenCanvas({
    type: '2d',
    width: rotated.width,
    height: rotated.height,
  })
  const fullCtx = full.getContext('2d') as WechatMiniprogram.IAnyObject
  const img = await imageOn(full, input.sourcePath)
  fullCtx.save()
  fullCtx.translate(rotated.width / 2, rotated.height / 2)
  fullCtx.rotate(turns * Math.PI / 2)
  if (input.flipH) fullCtx.scale(-1, 1)
  fullCtx.drawImage(img, -input.width / 2, -input.height / 2, input.width, input.height)
  fullCtx.restore()

  const rect = cropRect(rotated.width, rotated.height, input.ratio)
  const out = wx.createOffscreenCanvas({ type: '2d', width: rect.w, height: rect.h })
  const ctx = out.getContext('2d') as WechatMiniprogram.IAnyObject
  ctx.drawImage(full, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  return { path: await canvasToJpg(out), width: rect.w, height: rect.h }
}
