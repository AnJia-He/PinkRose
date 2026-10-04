import { lookup } from 'node:dns/promises'
import { HttpError } from './http.ts'

/**
 * **这个地址是不是指向本机 / 内网？**
 *
 * ★ 2026-10-02 加的（安全审计 S1，实测过）。在那之前 `normalizeBaseUrl` 只要求
 *   主机名里得有个点（`!u.hostname.includes('.')`），于是 `127.0.0.1`、
 *   `169.254.169.254`、`10.0.0.1`、`192.168.1.50` **全部放行** ——
 *   而用户填的接口地址是会被服务端**拿去发请求**的。也就是说：
 *   任何人注册一个号，就能把这台机器当成跳板去扫内网（靠返回的失败原因是
 *   "连不上 / 没这个接口 / 钥匙不对"三态区分端口开没开），
 *   或者向内网任意主机发盲 POST。
 *
 * ⚠️ **它挡的是"字面量"**（IP 直写、以及那些一看就知道是内部的域名）。
 *
 * ⚠️⚠️ **2026-10-04 更正了原来写在这儿的一段估计。** 原文说"挡不住的只有 DNS
 *   重绑定，那要求攻击者控制一个域名，比填个 127.0.0.1 贵得多" —— **错了，实测过**：
 *   `127.0.0.1.nip.io`、`10.0.0.1.sslip.io` 这类**公共通配 DNS** 免费、开箱即用，
 *   域名看着完全正常（不是字面量，黑名单看不见它），一解析就指向内网（本机三个全中）。
 *   一分钱不用花，所以字面量这道单独站着等于没有。
 *   → 于是补了下头 `assertResolvedHostAllowed`：**发请求前把域名解析成 IP 再判一次**。
 *   剩下的缝只有真·重绑定（我们解析一次、fetch 自己再解析一次，两次之间 DNS 换答案）——
 *   那一条才要求攻击者持续控制 DNS 应答，比"捡个公共域名"贵得多。
 *
 * ⚠️ **自建服务（Ollama 那一类）默认被挡**，要有意打开开关才放行 ——
 *   见 `assertModelHostAllowed` 里那段取舍。
 */

/** `0.0.0.0/8 · 10/8 · 127/8 · 169.254/16 · 172.16/12 · 192.168/16 · 100.64/10` */
const PRIVATE_V4: readonly RegExp[] = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

/** 一看就是"内部用的"域名后缀。`metadata.google.internal` 是云上的凭据服务。 */
const INTERNAL_SUFFIX = ['.localhost', '.internal', '.local', '.home.arpa']

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '') // 尾点：`localhost.` 也是 localhost

  // IPv6 从 URL 里出来是**带方括号**的（`[::1]`）
  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1)
    if (inner === '::1' || inner === '::') return true
    if (inner.startsWith('::ffff:')) return true            // IPv4-mapped，里面藏着一个 v4
    if (/^f[cd][0-9a-f]{2}:/.test(inner)) return true       // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(inner)) return true       // fe80::/10 链路本地
    return false
  }

  if (h === 'localhost') return true
  if (INTERNAL_SUFFIX.some(s => h.endsWith(s))) return true
  return PRIVATE_V4.some(re => re.test(h))
}

/** 开关名。**默认关** —— 理由见 `assertModelHostAllowed`。 */
export const ALLOW_PRIVATE_HOSTS_ENV = 'ALLOW_PRIVATE_MODEL_HOSTS'

/** 拒绝的话**只有这一份**：同步那道和解析后那道必须说同一句，不然会各自漂。 */
function deniedByPolicy(): HttpError {
  return new HttpError(
    'BAD_REQUEST',
    '这个地址指向本机或内网，默认不让填 —— 不然别人可以把这里当成跳板去扫你家的网络。' +
    `要用自己搭的模型服务，让部署的人在环境变量里设 ${ALLOW_PRIVATE_HOSTS_ENV}=1。`,
  )
}

/**
 * 不通过就抛 `HttpError`。**两条路都要调它**：
 *   ① 保存配置时（`normalizeBaseUrl`）—— 新填的地址当场拦下；
 *   ② **发请求前**（`clientFor`）—— 库里**已经存着**的私网地址也得拦，
 *      因为校验是后来才加的，存量配置不会自己消失。
 *
 * ⚠️ 取舍：默认关死会挡住"我自己在家跑个 Ollama"这个**正当**用法。
 *   但那是一个"少一个功能"的代价，而默认放行是"任何人注册个号就能拿我们
 *   扫内网"。**谁更贵很清楚**，所以默认关，要用的人显式打开开关。
 */
export function assertModelHostAllowed(url: string, env: NodeJS.ProcessEnv = process.env): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }
  if (!isPrivateHostname(hostname)) return
  if (env[ALLOW_PRIVATE_HOSTS_ENV] === '1') return

  throw deniedByPolicy()
}

/** 把一个主机名解析成它**实际指向的 IP**（可能多个）。测试注入用。 */
export type HostLookup = (hostname: string) => Promise<string[]>

const dnsLookup: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map(a => a.address)

/**
 * ★ 2026-10-04：**发请求前的那一道** —— 把域名解析成 IP，按**解析结果**再判一次。
 *
 * 为什么必须有它：上面那条黑名单只认字面量，而 `127.0.0.1.nip.io`、
 * `10.0.0.1.sslip.io` 这类**公共通配 DNS** 免费就能把任意内网地址包装成一个
 * "看着完全正常"的域名（实测：本机三个全中）。只站字面量那道 = 形同虚设。
 *
 * 调用点（**两条都调**，和同步那道同一个规矩）：
 *   · `clientFor.ts` —— 按用户现取连接时（真正发请求的那两条路都从这里过）；
 *   · `app.ts` 的「测一下」—— 它本身就是"靠失败原因扫端口"的探测器。
 *
 * ⚠️ 解析不出来时**放行**（返回而不是抛）：域名打错字是常见事，
 *   那种情况让**真正的请求**去报它自己的错（"连不上上游：…"），
 *   那里的文案是现成的；在这里另起一句只会多一种说法。
 *
 * ⚠️ 残余（写清楚，别当成堵死了）：我们解析一次、fetch 再解析一次 ——
 *   两次之间 DNS 还能换答案（真·重绑定）。彻底堵死要在建立连接那一刻判，
 *   而 Node 不公开 undici 的 lookup 钩子（得装依赖）。现在这条把
 *   "捡个免费域名"那一整类堵掉了，剩下的那条缝贵得多。
 */
export async function assertResolvedHostAllowed(
  url: string,
  opts: { env?: NodeJS.ProcessEnv; lookup?: HostLookup } = {},
): Promise<void> {
  const env = opts.env ?? process.env
  if (env[ALLOW_PRIVATE_HOSTS_ENV] === '1') return

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }
  // 字面量先判：不用查 DNS，也别为 `localhost` 这种白查一次
  if (isPrivateHostname(hostname)) throw deniedByPolicy()

  // IPv6 从 URL 里出来带方括号，`dns.lookup` 不认方括号
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  let addrs: string[]
  try {
    addrs = await (opts.lookup ?? dnsLookup)(bare)
  } catch {
    return
  }
  // 任何一条解析结果落在内网就拒 —— 有的域名会同时给公网和内网地址
  if (addrs.some(a => isPrivateHostname(a.includes(':') ? `[${a}]` : a))) {
    throw deniedByPolicy()
  }
}
