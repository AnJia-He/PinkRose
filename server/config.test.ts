import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CHAT_MODEL, loadConfig, describeConfig } from './config.ts'

const FULL = {
  AGNES_API_KEY: 'sk-agnes-test',
  SN_API_KEY: 'sk-test-abc',
  SN_BASE_URL: 'https://token.sensenova.cn/v1',
  SN_IMAGE_MODEL: 'sensenova-u1.5-fast',
  SESSION_SECRET: 'secret-test-session-key',
}

describe('loadConfig', () => {
  it('读齐两条通道，并把 baseUrl 结尾的斜杠去掉', () => {
    const c = loadConfig({ ...FULL, SN_BASE_URL: 'https://x.cn/v1/' })
    expect(c.image.baseUrl).toBe('https://x.cn/v1')
    expect(c.image.model).toBe('sensenova-u1.5-fast')
    expect(c.chat.apiKey).toBe('sk-agnes-test')
    expect(c.port).toBe(8787)
  })

  /**
   * ★ 2026-10-03 加。这条钉的是**这次改动本身**：两条通道不是同一家。
   * 少了它，"把 chat 的地址抄成商汤的"这种手滑**全绿**（两边各自都像个正常配置），
   * 而线上表现是：路由跑到商汤去了 —— 不报错，只是慢 4~8 倍、花的是另一个账户的钱。
   */
  it('★ 两条通道的默认地址**不是同一家**（chat 走 Agnes、image 走商汤）', () => {
    const c = loadConfig({ ...FULL, SN_BASE_URL: '' })
    expect(c.chat.baseUrl).toBe('https://apihub.agnes-ai.com/v1')
    expect(c.image.baseUrl).toBe('https://token.sensenova.cn/v1')
    expect(c.chat.baseUrl).not.toBe(c.image.baseUrl)
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

  /** ★ 2026-10-03 加：对话那条通道的钥匙也是**必填**（少它路由整个废掉）。 */
  it('缺 AGNES_API_KEY 也直接抛错，报的是它自己那个变量名', () => {
    const noKey = { ...FULL, AGNES_API_KEY: '' }
    expect(() => loadConfig(noKey)).toThrow(/AGNES_API_KEY/)
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
    // ⚠️ 这里**必须把两条通道的 key 都给上**（2026-10-03 起是两把）：少哪一把，
    // 都会先栽在那一条上，于是它对"SESSION_SECRET 被给了个硬编码默认值"这个变异
    // **永远不会红**（实测：把 sessionSecret 改成 `'dev-secret'` 的兜底，那版照绿）。
    // 一条永远不可能红、却看起来在守着一件事的断言，比没有更糟。
    expect(() => loadConfig({ AGNES_API_KEY: 'k', SN_API_KEY: 'k' })).toThrow(/SESSION_SECRET/)
  })

  it('SESSION_SECRET 只有空白也算缺', () => {
    expect(() => loadConfig({ ...FULL, SESSION_SECRET: '   ' })).toThrow(/SESSION_SECRET/)
  })

  it('key 只有空白也算缺', () => {
    expect(() => loadConfig({ ...FULL, SN_API_KEY: '   ' })).toThrow(/SN_API_KEY/)
  })

  it('缺模型名时用各自的默认值，不抛错', () => {
    // SESSION_SECRET 在这里给全：这条问的是"模型名有没有默认值"，
    // 不该因为另一个必填项而红 —— 那样它就不再是它自己了。
    const c = loadConfig({
      AGNES_API_KEY: 'sk-a', SN_API_KEY: 'sk-x',
      SN_BASE_URL: 'https://x.cn/v1', SESSION_SECRET: 'x',
    })
    expect(c.image.model).toBe('sensenova-u1.5-fast')
    expect(c.chat.model).toBe('agnes-2.5-flash')
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

  it('没给 PHOTO_DIR 时落在"当前工作目录"的 data/photos —— 和 dbPath 一样跟着 cwd 走', () => {
    // 形状和理由都照上面那条 dbPath 的（"别复读实现"那一段）：照片目录同样必须跟着
    // cwd 走 —— 改成按模块位置派生的话，从别处启动就会把图存进另一个目录，而
    // "用户的图在哪"一旦有两个答案，排查起来很贵（config.ts 里那段注释）。
    // 库和照片**必须落在同一个根下**，不然备份/搬家会漏掉一半。
    const dir = mkdtempSync(join(tmpdir(), 'ruixing-cfg-photos-'))
    const before = process.cwd()
    try {
      process.chdir(dir)
      expect(loadConfig(FULL).photoDir).toBe(resolve(process.cwd(), 'data', 'photos'))
      process.chdir(before)
      expect(loadConfig(FULL).photoDir).toBe(resolve(before, 'data', 'photos'))
    } finally {
      process.chdir(before)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('给了 PHOTO_DIR 就用它 —— 不许被默认值盖掉', () => {
    expect(loadConfig({ ...FULL, PHOTO_DIR: '/tmp/pics' }).photoDir).toBe('/tmp/pics')
  })
})

describe('describeConfig', () => {
  it('摘要里绝不出现 API key —— 它会被打日志', () => {
    const s = describeConfig(loadConfig(FULL))
    expect(s).not.toContain('sk-test-abc')
    expect(s).not.toContain('sk-agnes-test')
    // ★ 两条通道的模型名都要在：排查"到底哪条走到哪家去了"全靠这一行
    expect(s).toContain('sensenova-u1.5-fast')
    expect(s).toContain(DEFAULT_CHAT_MODEL)
  })

  it('签名钥匙只报「已设置」，绝不回显 —— 这个字符串会被打日志', () => {
    const s = describeConfig(loadConfig({ ...FULL, SESSION_SECRET: 'secret-must-not-appear-f3a1' }))
    expect(s).not.toContain('secret-must-not-appear-f3a1')
    expect(s).toContain('secret=已设置')
  })
})
