import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, describeConfig } from './config.ts'

const FULL = {
  SN_API_KEY: 'sk-test-abc',
  SN_BASE_URL: 'https://token.sensenova.cn/v1',
  SN_IMAGE_MODEL: 'sensenova-u1.5-fast',
  SN_VLM_MODEL: 'sensenova-6.8-flash-lite',
  SESSION_SECRET: 'secret-test-session-key',
}

describe('loadConfig', () => {
  it('读齐四个字段，并把 baseUrl 结尾的斜杠去掉', () => {
    const c = loadConfig({ ...FULL, SN_BASE_URL: 'https://x.cn/v1/' })
    expect(c.baseUrl).toBe('https://x.cn/v1')
    expect(c.imageModel).toBe('sensenova-u1.5-fast')
    expect(c.vlmModel).toBe('sensenova-6.8-flash-lite')
    expect(c.port).toBe(8787)
  })

  it('SESSION_SECRET 原样读进来 —— 后面每一张票都靠它签', () => {
    expect(loadConfig(FULL).sessionSecret).toBe('secret-test-session-key')
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

  it('★ 缺 SESSION_SECRET 就抛错 —— 绝不给一个写死在代码里的默认值', () => {
    // ⚠️ 为什么这条必须存在：这个默认值一旦被"顺手"补上，等于**没有签名** ——
    // 谁都能自己造一张票进来，冒充任何人。而它补上去之后，**全仓测试照样全绿**
    // （没有别的用例在问这件事），只能靠这一条守着。
    expect(() => loadConfig({ ...FULL, SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/)
    // 只给 API key、别的什么都不给的极端环境也要抛 —— 不能"什么都没配，反而放行"。
    // ⚠️ 这里**必须把 SN_API_KEY 给上**：全空环境必然先栽在 SN_API_KEY 那一条，
    // 于是它对"SESSION_SECRET 被给了个硬编码默认值"这个变异**永远不会红**
    // （实测：把 sessionSecret 改成 `'dev-secret'` 的兜底，全空这版照绿）。
    // 一条永远不可能红、却看起来在守着一件事的断言，比没有更糟。
    expect(() => loadConfig({ SN_API_KEY: 'k' })).toThrow(/SESSION_SECRET/)
  })

  it('SESSION_SECRET 只有空白也算缺', () => {
    expect(() => loadConfig({ ...FULL, SESSION_SECRET: '   ' })).toThrow(/SESSION_SECRET/)
  })

  it('key 只有空白也算缺', () => {
    expect(() => loadConfig({ ...FULL, SN_API_KEY: '   ' })).toThrow(/SN_API_KEY/)
  })

  it('缺模型名时用默认值，不抛错', () => {
    // SESSION_SECRET 在这里给全：这条问的是"模型名有没有默认值"，
    // 不该因为另一个必填项而红 —— 那样它就不再是它自己了。
    const c = loadConfig({ SN_API_KEY: 'sk-x', SN_BASE_URL: 'https://x.cn/v1', SESSION_SECRET: 'x' })
    expect(c.imageModel).toBe('sensenova-u1.5-fast')
    expect(c.vlmModel).toBe('sensenova-6.8-flash-lite')
  })

  it('没给 DB_PATH 时落在"当前工作目录"的 data/ruixing.db —— 钉的是"跟着 cwd 走"这件事', () => {
    // ⚠️ 原来这条写的是 `expect(loadConfig(FULL).dbPath).toBe(resolve(process.cwd(), 'data', 'ruixing.db'))`
    // —— 那就是实现里那一行的**复读**：实现改成按 `import.meta.url` 派生、或者写死一个
    // 绝对路径，只要断言照着抄一遍，它照样绿。而复读是抓不住任何东西的（这个项目
    // 已经被"测试没在测它名字说的东西"咬过好几次）。
    //
    // 真正要钉的是**"跟着 cwd 走"本身**：把 cwd 换到一个临时目录，默认路径就得跟着换。
    // cwd ≠ 模块所在目录，这一步才是整条测试的力量来源 —— 按模块位置派生的实现，
    // 在这里必然给出另一个答案（那正是注释里那句"从别处启动就会另开一个空库"）。
    const dir = mkdtempSync(join(tmpdir(), 'ruixing-cfg-'))
    const before = process.cwd()
    try {
      process.chdir(dir)
      // 右半边也在新 cwd 里现算 —— 两边一起动，比的才是"它跟不跟 cwd"
      expect(loadConfig(FULL).dbPath).toBe(resolve(process.cwd(), 'data', 'ruixing.db'))
      // 换一个 cwd 再来一次：这一步把"恰好是那个值"排掉，只留下"跟着走"
      process.chdir(before)
      expect(loadConfig(FULL).dbPath).toBe(resolve(before, 'data', 'ruixing.db'))
    } finally {
      process.chdir(before)
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('签名钥匙只报「已设置」，绝不回显 —— 这个字符串会被打日志', () => {
    const s = describeConfig(loadConfig({ ...FULL, SESSION_SECRET: 'secret-must-not-appear-f3a1' }))
    expect(s).not.toContain('secret-must-not-appear-f3a1')
    expect(s).toContain('secret=已设置')
  })
})
