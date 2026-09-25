import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage, type Storage } from './storage.ts'

describe('createStorage', () => {
  let root: string
  let s: Storage

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ruixing-storage-'))
    s = createStorage(root)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('存进去能原样读回来', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251])
    const name = await s.save(bytes, '.jpg')
    expect(await s.read(name)).toEqual(bytes)
  })

  it('同样两份内容存两次，名字不一样 —— 文件名必须是随机串', async () => {
    const bytes = new Uint8Array([9, 9, 9])
    const a = await s.save(bytes, '.jpg')
    const b = await s.save(bytes, '.jpg')
    expect(a).not.toBe(b)
  })

  it('名字里不许带路径 —— 不然能拿它逃出这个目录', async () => {
    const evil = '../'.repeat(4) + 'x.jpg'
    await expect(s.read(evil)).rejects.toThrow(/不合法的文件名/)
    // ⚠️ 下面两条原来是**裸的 `toThrow()`**（任何抛出都满足它，等于没说是谁抛的），
    //    而计划里那三行说明**既没搬进这个文件、又说错了归属**（2026-09-25 终审 M7）。
    //    收成指名道姓，顺手把归属写在这儿：
    //   · `remove` 走的就是 **`NAME_OK`** —— `force: true` 只管"文件本来就不在也算成功"，
    //     管不了名字。它有牙：把 `NAME_OK` 去掉，这条会 resolve（await 不抛）→ 红。
    await expect(s.remove(evil)).rejects.toThrow(/不合法的文件名/)
    // 扩展名也是调用方给的 —— 同样不许它带路径。
    // ⚠️ 它撞的是 **`EXT_OK`**（`save` 第一行，`pathOf` 还没被调用到），
    //    **不是** `NAME_OK` 兜住的 —— 计划原稿把这句写反了。
    await expect(s.save(new Uint8Array([1]), '/../evil')).rejects.toThrow(/不合法的扩展名/)
  })

  it('删了就读不到了；再删一次不炸（删两遍 = 成功）', async () => {
    const name = await s.save(new Uint8Array([1, 2]), '.jpg')
    await s.remove(name)
    await expect(s.read(name)).rejects.toThrow()
    await expect(s.remove(name)).resolves.toBeUndefined()
  })

  it('sizeOf 报的是真实字节数', async () => {
    const name = await s.save(new Uint8Array(1234), '.jpg')
    expect(await s.sizeOf(name)).toBe(1234)
  })
})
