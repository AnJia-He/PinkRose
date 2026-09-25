import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadConfig, describeConfig } from './config.ts'

const FULL = {
  SN_API_KEY: 'sk-test-abc',
  SN_BASE_URL: 'https://token.sensenova.cn/v1',
  SN_IMAGE_MODEL: 'sensenova-u1.5-fast',
  SN_VLM_MODEL: 'sensenova-6.8-flash-lite',
}

describe('loadConfig', () => {
  it('读齐四个字段，并把 baseUrl 结尾的斜杠去掉', () => {
    const c = loadConfig({ ...FULL, SN_BASE_URL: 'https://x.cn/v1/' })
    expect(c.baseUrl).toBe('https://x.cn/v1')
    expect(c.imageModel).toBe('sensenova-u1.5-fast')
    expect(c.vlmModel).toBe('sensenova-6.8-flash-lite')
    expect(c.port).toBe(8787)
  })

  it('缺 SN_API_KEY 直接抛错，且错误信息里不含 key 的值', () => {
    // 用空串而不是解构剔除：解构会产生一个未使用的变量，
    // tsconfig 的 noUnusedLocals 会把它判成错误
    const noKey = { ...FULL, SN_API_KEY: '' }
    expect(() => loadConfig(noKey)).toThrow(/SN_API_KEY/)
    // 反向断言：错误信息不能被拿来当泄漏通道
    try { loadConfig(noKey) } catch (e) {
      expect(String(e)).not.toContain('sk-')
    }
  })

  it('key 只有空白也算缺', () => {
    expect(() => loadConfig({ ...FULL, SN_API_KEY: '   ' })).toThrow(/SN_API_KEY/)
  })

  it('缺模型名时用默认值，不抛错', () => {
    const c = loadConfig({ SN_API_KEY: 'sk-x', SN_BASE_URL: 'https://x.cn/v1' })
    expect(c.imageModel).toBe('sensenova-u1.5-fast')
    expect(c.vlmModel).toBe('sensenova-6.8-flash-lite')
  })

  it('没给 DB_PATH 时落在仓库根的 data/ruixing.db', () => {
    // 断言的是"相对于 cwd"，不是某台机器上的绝对路径 —— 所以别的机器上也成立。
    // 它挡的是"默认值被写死成某个具体路径"：那样开发机和服务器的库就不是同一个了。
    expect(loadConfig(FULL).dbPath).toBe(resolve(process.cwd(), 'data', 'ruixing.db'))
  })

  it('给了 DB_PATH 就用它 —— 不许被默认值盖掉', () => {
    expect(loadConfig({ ...FULL, DB_PATH: '/tmp/x.db' }).dbPath).toBe('/tmp/x.db')
  })
})

describe('describeConfig', () => {
  it('摘要里绝不出现 API key —— 它会被打日志', () => {
    const s = describeConfig(loadConfig(FULL))
    expect(s).not.toContain('sk-test-abc')
    expect(s).toContain('sensenova-6.8-flash-lite')
  })
})
