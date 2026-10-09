/**
 * Blob → data URL。
 *
 * ★ 2026-10-09 收口：这一小段 `FileReader` 包了**三遍** —— `export/save.ts` 里
 *   两处（`fileToDataUrl` 和 `blobToDataUrl`，只有 onerror 一行不同）、
 *   `image/prepare.ts` 里一处。作品集那条路的图是 base64 走 JSON 的（裁定 ①），
 *   画布那边给的是 Blob，中间就靠这一步。
 *
 * `FileReader` 是浏览器自带的，不用新依赖。
 *
 * ⚠️ 失败时给的是**一句人话**，不是 `r.error` 那个 DOMException：
 *   作品集那条路会把这句话直接说给用户听（`withExif` 那边会 catch 再降级成
 *   "没有 EXIF 的导出图"）。读不出来基本只有一种原因：这个 Blob / File 已经失效了。
 *   `File` 是 `Blob` 的子类 —— 传文件进来也走这一条，不必另写一份。
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('这张图读不出来，再试一次'))
    r.readAsDataURL(blob)
  })
}
