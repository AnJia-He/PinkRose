import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/**
 * 图片文件的那一层。**只有这个文件碰 `data/photos/`** ——
 * 以后上线换云存储（OSS / S3），改这里就够了，`works.ts` 一个字不用动（§4.3）。
 *
 * 这一层**只认名字，不认路径**：调用方给它的是 `save` 返回的那个随机串，根目录由它自己拼。
 * 所以名字里带 `/` 或 `..` 一律拒 —— 那种名字本来不该出现，出现了就说明有脏东西在往里塞。
 */
const NAME_OK = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/
const EXT_OK = /^\.[A-Za-z0-9]+$/

export type Storage = {
  /** 存一份，返回它在这层里的名字（随机串 + 扩展名）。调用方只管拿这个名字，别自己拼路径 */
  save(bytes: Uint8Array, ext: string): Promise<string>
  /** 按名字读回来。名字不合法、或文件不在 → 抛 */
  read(name: string): Promise<Uint8Array>
  /** 删掉。文件本来就不在 = 成功（删两次不该炸） */
  remove(name: string): Promise<void>
  /** 多大。不在 → 抛 */
  sizeOf(name: string): Promise<number>
}

/** root 是这一层的根目录。生产传 `data/photos`，测试传临时目录 */
export function createStorage(root: string): Storage {
  // 根目录先建出来 —— 第一次存的时候 data/photos 还不存在
  mkdirSync(root, { recursive: true })

  const pathOf = (name: string): string => {
    if (!NAME_OK.test(name)) throw new Error(`不合法的文件名：${name}`)
    return join(root, name)
  }

  return {
    async save(bytes, ext) {
      // 扩展名也过一遍守卫 —— 它同样是调用方给的
      if (!EXT_OK.test(ext)) throw new Error(`不合法的扩展名：${ext}`)
      // 16 字节随机 = 32 个十六进制字符。
      // **不能是 1、2、3** —— 顺序数字的话，别人改一下数字就拿到你的图（§4.3）
      const name = randomBytes(16).toString('hex') + ext
      await writeFile(pathOf(name), bytes)
      return name
    },
    async read(name) {
      return new Uint8Array(await readFile(pathOf(name)))
    },
    async remove(name) {
      // force: true —— 文件本来就不在也算成功。
      // 删两次不该炸：批量删里"它已经被别处删过了"是**正常情况**，不是错误（§3.5）
      await rm(pathOf(name), { force: true })
    },
    async sizeOf(name) {
      return (await stat(pathOf(name))).size
    },
  }
}
