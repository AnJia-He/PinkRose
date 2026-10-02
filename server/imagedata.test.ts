import { describe, it, expect } from 'vitest'
import { decodeDataUrl, MAX_THUMB_BYTES } from './imagedata.ts'

/** 一张最小的"真" JPEG：只有文件头那三字节，够魔数校验用。 */
const jpeg = (extra = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(extra)])
/** 一张最小的"真" PNG：那八个字节的签名。 */
const png = (extra = '') =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(extra)])

const url = (mime: string, bytes: Buffer) => `data:image/${mime};base64,${bytes.toString('base64')}`

describe('decodeDataUrl', () => {
  it('真的 jpeg / png 照常解出来，扩展名跟着走', () => {
    expect(decodeDataUrl(url('jpeg', jpeg('x'))).ext).toBe('.jpg')
    expect(decodeDataUrl(url('png', png('x'))).ext).toBe('.png')
  })

  /**
   * ★ 2026-10-02 加（安全审计：上传只信声明的 MIME，不验魔数）。
   *
   * 加之前：`{"image":"data:image/png;base64,<任意字节>"}` 会**原样落盘**成 `.png`，
   * 回读时还带着 `content-type: image/png`。今天危害有限（服务端不解码图片）
   * —— 但**哪天谁给图片加一步服务端解码/转码，这里立刻变成实洞**。
   * 而且"存在盘上的东西和它的扩展名对不上"本身就是个迟早要还的债。
   */
  it('★ 声明的类型和内容对不上 → 拒', () => {
    // HTML 冒充 png
    expect(() => decodeDataUrl(url('png', Buffer.from('<html><script>alert(1)</script>')))).toThrow()
    // zip 冒充 jpeg
    expect(() => decodeDataUrl(url('jpeg', Buffer.from([0x50, 0x4b, 0x03, 0x04])))).toThrow()
    // 反着来：真 PNG 声明成 jpeg
    expect(() => decodeDataUrl(url('jpeg', png()))).toThrow()
    // 真 JPEG 声明成 png
    expect(() => decodeDataUrl(url('png', jpeg()))).toThrow()
    // 空的
    expect(() => decodeDataUrl(url('png', Buffer.alloc(0)))).toThrow()
  })

  it('前三个字节对、后面是垃圾的，不追究（校验的是"是不是这个格式"，不是"能不能解码"）', () => {
    // 刻意只验文件头：真去解码就得引一个图像库，而这一层**不该**认识图像格式。
    // 它能保证的是"存在盘上的东西确实是它自称的那种格式"——够了。
    expect(decodeDataUrl(url('jpeg', jpeg('这不是合法的 JPEG 数据'))).ext).toBe('.jpg')
  })

  it('原本就该拒的形状照旧拒', () => {
    expect(() => decodeDataUrl('data:image/gif;base64,R0lGOD')).toThrow()
    expect(() => decodeDataUrl('http://example.com/a.png')).toThrow()
    expect(() => decodeDataUrl('data:image/png;base64,有换行\n的')).toThrow()
  })
})

describe('MAX_THUMB_BYTES', () => {
  it('比一张作品小得多 —— 缩略图本来就该是小图', () => {
    // 作品那张的上限是 8 MB。缩略图要是也 8 MB，那"每张作品最多 8 MB"这句
    // 就不成立了（一个请求能写进来约 9 MB）。
    expect(MAX_THUMB_BYTES).toBeLessThanOrEqual(1024 * 1024)
  })
})
