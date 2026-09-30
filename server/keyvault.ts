import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * 用户自己的模型钥匙怎么加密存。
 *
 * ★ **全仓库只有这一个文件碰"钥匙的密文"。** 谁都不许自己写加解密 ——
 * 那正是会漂的东西（同一条项目规矩：主按钮的长相只有一份、
 * 参数名字表只有一份、图片文件那一层只有 storage.ts）。
 *
 * 形状照 LobeChat 的 `KeyVaultsGateKeeper`（六个开源实现里唯一真做了
 * 服务端加密的）：AES-256-GCM + 每次全新随机 IV + 认证标签。
 *
 * ⚠️ 存成 `v1:iv:tag:data` 四段而不是 LobeChat 的三段 —— 多一个 **版本前缀**。
 * 将来要换算法时，老密文还认得出来（"看不懂"和"被篡改了"必须是两种结局）。
 */

/** 段数、算法。改这个字符串 = 换算法，必须同时改 SEALED_VERSION。 */
const ALG = 'aes-256-gcm'
const SEALED_VERSION = 'v1'
const IV_BYTES = 12   // GCM 的标准长度
const TAG_BYTES = 16
const KEY_BYTES = 32  // AES-256

/**
 * 从主密钥派生**这一种用途专用**的一把钥匙。
 *
 * ⚠️ 为什么不直接拿 `SESSION_SECRET` 当钥匙：那是**同一个字节串用于两种用途**
 * （签名会话 + 加密钥匙）。密码学上这叫"密钥复用"，是明确的坏习惯 ——
 * 两边的输出一旦有任何一处能被观察到，就等于漏了另一边的一半信息。
 *
 * HKDF 的 `info` 参数就是这个用途的**域分隔符**：同一把 `SESSION_SECRET`
 * 派出来的这把钥匙，和签名用的那把，在数学上没有任何可推导的关系。
 * （TYPO3 那份 ADR 用的也是这个套路，它叫"domain-separated key derivation"。）
 */
function deriveKey(masterSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterSecret, '', 'ruixing:model-key-vault:v1', KEY_BYTES),
  )
}

export type Vault = {
  /** 把明文钥匙封成能进库的字符串 */
  seal(plaintext: string): string
  /**
   * 打开。**永不抛** —— 畸形输入、被改过的密文、换了主钥匙，
   * 一律回 `{ plaintext: '', authentic: false }`。
   *
   * 为什么"永不抛"是这里的重点：这段密文是从**数据库**读出来的，
   * 而数据库里的东西坏掉（或者 SESSION_SECRET 被人换过）**不该让接口 500** ——
   * 500 是"我们的代码坏了"，而这件事的正确答案是"这把钥匙读不出来了，
   * 请用户重新填一次"。让调用方拿到 `authentic: false` 去说那句话，
   * 比让它接一个异常清楚得多。
   */
  open(sealed: string): { plaintext: string; authentic: boolean }
}

export function createVault(masterSecret: string): Vault {
  const key = deriveKey(masterSecret)

  return {
    seal(plaintext) {
      // 每次一个全新的随机 IV。**这一条不能省**：固定 IV 的话，
      // 同一把钥匙会封出同一串密文 —— 看库的人不用解开就知道
      // "这两个人填的是同一把钥匙"。GCM 下重用 IV 还会直接泄露明文异或。
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALG, key, iv)
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [SEALED_VERSION, iv.toString('hex'), tag.toString('hex'), data.toString('hex')].join(':')
    },

    open(sealed) {
      const fail = { plaintext: '', authentic: false }
      if (typeof sealed !== 'string') return fail

      const parts = sealed.split(':')
      // 段数不对 = 不是我们封的东西（或者被人改过形状）
      if (parts.length !== 4) return fail
      const [version, ivHex, tagHex, dataHex] = parts as [string, string, string, string]
      // 版本不认识 = 「看不懂」，照样是 fail —— 调用方的处置一样（让用户重填）
      if (version !== SEALED_VERSION) return fail

      const iv = hexOf(ivHex, IV_BYTES)
      const tag = hexOf(tagHex, TAG_BYTES)
      const data = hexOf(dataHex, -1)
      if (!iv || !tag || !data) return fail

      try {
        const d = createDecipheriv(ALG, key, iv)
        d.setAuthTag(tag)
        const plaintext = Buffer.concat([d.update(data), d.final()]).toString('utf8')
        return { plaintext, authentic: true }
      } catch {
        // 认证标签对不上（被改过 / 换了主钥匙）→ 这里唯一正确的做法是**安静地说不知道**。
        // 不打印 `sealed`，也不打印异常原文 —— 它们可能带着密文的片段，
        // 而"钥匙绝不进日志"是这一版的硬规矩（§7.7）。
        return fail
      }
    },
  }
}

/**
 * 严格的 hex 解析。`Buffer.from(x, 'hex')` 对畸形输入**不抛**，
 * 它会截断到最后一个完整字节 —— 于是 `'zz'` 变成空 Buffer，
 * 而空 IV 会让 `createDecipheriv` 抛。这里自己判，把它挡在前面。
 *
 * `wantBytes` 传 -1 表示"长度不限"（密文长度本来就是变的）。
 */
function hexOf(hex: string, wantBytes: number): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  if (wantBytes >= 0 && hex.length !== wantBytes * 2) return null
  if (!/^[0-9a-f]+$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}
