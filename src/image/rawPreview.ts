/**
 * 从 RAW 容器里找相机写入的 JPEG 预览。
 *
 * 这里不解 RAW、不做去马赛克，也不假装拿到 14-bit 原始数据。它只做相机 /
 * 手机摄影工作流里很实用的一步：当浏览器和本机转换器都打不开 RAW 时，从
 * DNG / CR2 / NEF / ARW / RAF / CR3 等文件里提取相机已经生成的大 JPEG 预览，
 * 让用户先进入修图。真正的 RAW 高光恢复和位深仍需要厂商软件或本机 RAW 解码器。
 */

export type EmbeddedJpegPreview = {
  offset: number
  length: number
  width: number
  height: number
}

/** 小于这个长边的多半是相册缩略图，放大就糊，不作为正式预览。 */
export const MIN_RAW_PREVIEW_EDGE = 640
/** 防止异常文件把扫描拖成无限循环。 */
const MAX_JPEG_BYTES = 80 * 1024 * 1024

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf
    && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(bytes: Uint8Array, start: number, end: number): {
  width: number
  height: number
} | null {
  let offset = start + 2
  while (offset + 4 <= end) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    let markerAt = offset + 1
    while (markerAt < end && bytes[markerAt] === 0xff) markerAt++
    if (markerAt >= end) return null
    const marker = bytes[markerAt]!
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerAt + 1
      continue
    }
    const lengthAt = markerAt + 1
    if (lengthAt + 2 > end) return null
    const length = bytes[lengthAt]! * 256 + bytes[lengthAt + 1]!
    if (length < 2 || lengthAt + length > end) return null
    if (isSofMarker(marker)) {
      if (lengthAt + 7 > end) return null
      const height = bytes[lengthAt + 3]! * 256 + bytes[lengthAt + 4]!
      const width = bytes[lengthAt + 5]! * 256 + bytes[lengthAt + 6]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    // 进入扫描数据后不会再有本帧的尺寸标记，前面的循环已经读到了 SOF。
    if (marker === 0xda) return null
    offset = lengthAt + length
  }
  return null
}

function jpegEnd(bytes: Uint8Array, start: number): number {
  const limit = Math.min(bytes.length, start + MAX_JPEG_BYTES)
  let offset = start + 2
  while (offset < limit) {
    const marker = bytes.indexOf(0xff, offset)
    if (marker < 0 || marker + 1 >= limit) return -1
    if (bytes[marker + 1] === 0xd9) return marker + 2
    offset = marker + 1
  }
  return -1
}

/**
 * 扫描整个容器，返回最大的有效 JPEG 预览。先按像素面积、再按文件大小选，
 * 这样同时存在 160px 缩略图和 1600px 预览时不会打开前者。
 */
export function findEmbeddedJpegPreview(bytes: Uint8Array): EmbeddedJpegPreview | null {
  let best: EmbeddedJpegPreview | null = null
  let scan = 0
  while (scan + 3 < bytes.length) {
    const start = bytes.indexOf(0xff, scan)
    if (start < 0 || start + 3 >= bytes.length) break
    if (bytes[start + 1] !== 0xd8 || bytes[start + 2] !== 0xff) {
      scan = start + 1
      continue
    }
    const end = jpegEnd(bytes, start)
    if (end <= start) {
      scan = start + 2
      continue
    }
    const size = jpegSize(bytes, start, end)
    if (size && Math.max(size.width, size.height) >= MIN_RAW_PREVIEW_EDGE) {
      const length = end - start
      const area = size.width * size.height
      const bestArea = best ? best.width * best.height : -1
      if (!best || area > bestArea || (area === bestArea && length > best.length)) {
        best = { offset: start, length, ...size }
      }
    }
    // 跳过整个 JPEG，避免把预览内部 EXIF 携带的小缩略图误当成候选。
    scan = end
  }
  return best
}
