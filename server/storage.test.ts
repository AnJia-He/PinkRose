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
    await expect(s.read(evil)).rejects.toThrow()
    await expect(s.remove(evil)).rejects.toThrow()
    // 扩展名也是调用方给的 —— 同样不许它带路径
    await expect(s.save(new Uint8Array([1]), '/../evil')).rejects.toThrow()
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
