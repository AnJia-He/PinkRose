/**
 * 读一张照片的宽高（照片电影排版用）。用 `<img>` 解码而不是 `createImageBitmap`：
 * iPhone 相册里的 HEIC 在 Safari 里走的是同一套图片解码，兼容面更宽。
 * 解码失败的图片由调用方跳过并提示，不拖垮整组。
 */
export function probePhotoFile(
  file: File, url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error('这张照片读不出尺寸，换一张试试。'))
        return
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => reject(new Error(`${file.name} 打不开，换一张试试。`))
    img.src = url
  })
}
