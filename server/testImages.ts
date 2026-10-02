/**
 * 测试用的假图片字节：**长度由调用方定，但文件头是真的**。
 *
 * ★ 2026-10-02 加。起因：`imagedata.ts` 从这天起会**验魔数**（安全审计 —— 原来
 *   只信声明的 MIME，`data:image/png;base64,<HTML>` 会被原样落盘成 `.png`）。
 *   而测试夹具当时用的是一串随便的字节（`'AAAA'`、`new Uint8Array(64).fill(7)`），
 *   于是 41 条用例一起红。
 *
 * ⚠️ **长度必须是恰好 n**，不是 `n + 3`：几个测试按字节数断言
 *   （`expect(got.bytes.byteLength).toBe(64)`、`expect(meta.bytes).toBe(999)`）。
 *   所以这里是"拿文件头覆盖前几字节"，不是"在前面插一段"。
 */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function withMagic(n: number, magic: readonly number[]): Uint8Array {
  const b = new Uint8Array(Math.max(0, n)).fill(7)
  if (n > 0) b.set(magic.slice(0, n) as number[])
  return b
}

/** n 个字节，以 JPEG 文件头开头。 */
export const jpegBytes = (n = 64): Uint8Array => withMagic(n, JPEG_MAGIC)

/** n 个字节，以 PNG 文件头开头。 */
export const pngBytes = (n = 64): Uint8Array => withMagic(n, PNG_MAGIC)

export const b64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** 可以直接塞进 `{ image: ... }` 的那种形状。 */
export const jpegUrl = (n = 64): string => `data:image/jpeg;base64,${b64Of(jpegBytes(n))}`
export const pngUrl = (n = 64): string => `data:image/png;base64,${b64Of(pngBytes(n))}`
