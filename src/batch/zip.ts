/**
 * 最小 ZIP 写入器（★ 2026-10-17，批量处理）。
 *
 * 批量照片导出只下载一个文件，比让浏览器连点二十次下载可靠得多。照片本身已经
 * 是 JPEG / PNG / WebP，再 deflate 一遍收益很小，所以这里用 store（不压缩）：
 * 实现短、速度快，而且零依赖 —— 不为一个 ZIP 头引入打包库。
 *
 * 支持范围只覆盖本项目需要的那一部分：
 *   · 单文件 < 4 GB、总包 < 4 GB；
 *   · UTF-8 文件名（general purpose bit 11）；
 *   · 固定时间戳 0（产物可重复，测试也稳定）。
 */

export type ZipEntry = {
  name: string
  data: Uint8Array<ArrayBuffer>
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP 里的路径永远用 `/`，并且去掉空段、`.` 和 `..`（不让包内路径逃出目录）。 */
export function safeZipName(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/')
  const safe = parts.filter(part => part && part !== '.' && part !== '..')
  return safe.join('/') || 'photo'
}

function set16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function set32(view: DataView, offset: number, value: number): void {
  if (value < 0 || value > 0xffffffff) throw new Error('批量压缩包超过 4 GB，请分两批处理。')
  view.setUint32(offset, value, true)
}

/**
 * `entries` 的顺序就是包里的顺序。空名单会抛 —— 调用方应在没有成功项时
 * 不生成下载，而不是给用户一个可以点、解压后空荡荡的 ZIP。
 */
export function buildZipBlob(entries: readonly ZipEntry[]): Blob {
  if (entries.length === 0) throw new Error('没有可打包的照片')
  if (entries.length > 0xffff) throw new Error('一次打包的文件太多了')

  const encoder = new TextEncoder()
  const localParts: BlobPart[] = []
  const centralParts: BlobPart[] = []
  let offset = 0

  for (const entry of entries) {
    const name = safeZipName(entry.name)
    const nameBytes = encoder.encode(name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    set32(lv, 0, 0x04034b50)
    set16(lv, 4, 20)              // version needed
    set16(lv, 6, 0x0800)          // UTF-8 filename
    set16(lv, 8, 0)               // store
    set16(lv, 10, 0)              // time
    set16(lv, 12, 0)              // date
    set32(lv, 14, crc)
    set32(lv, 18, size)
    set32(lv, 22, size)
    set16(lv, 26, nameBytes.length)
    set16(lv, 28, 0)
    local.set(nameBytes, 30)
    localParts.push(local, entry.data)

    const centralOffset = offset
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    set32(cv, 0, 0x02014b50)
    set16(cv, 4, 20)              // version made by
    set16(cv, 6, 20)              // version needed
    set16(cv, 8, 0x0800)          // UTF-8 filename
    set16(cv, 10, 0)              // store
    set16(cv, 12, 0)              // time
    set16(cv, 14, 0)              // date
    set32(cv, 16, crc)
    set32(cv, 20, size)
    set32(cv, 24, size)
    set16(cv, 28, nameBytes.length)
    set16(cv, 30, 0)              // extra
    set16(cv, 32, 0)              // comment
    set16(cv, 34, 0)              // disk
    set16(cv, 36, 0)              // internal attrs
    set32(cv, 38, 0)              // external attrs
    set32(cv, 42, centralOffset)
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += local.length + size
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => (
    sum + (part instanceof Uint8Array ? part.length : 0)
  ), 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  set32(ev, 0, 0x06054b50)
  set16(ev, 4, 0)
  set16(ev, 6, 0)
  set16(ev, 8, entries.length)
  set16(ev, 10, entries.length)
  set32(ev, 12, centralSize)
  set32(ev, 16, centralOffset)
  set16(ev, 20, 0)

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
}
