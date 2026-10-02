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
 *   挡不住的是 **DNS 重绑定**：域名先解析到公网、请求那一刻再解析到 127.0.0.1。
 *   真要堵死得在**建立连接时**按解析出来的 IP 判（undici 的 `lookup` 钩子），
 *   而 Node 不公开 undici 的 API（得装依赖）。这个残余风险记在这儿：
 *   它要求攻击者控制一个域名，比"填个 127.0.0.1"贵得多。
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

  throw new HttpError(
    'BAD_REQUEST',
    '这个地址指向本机或内网，默认不让填 —— 不然别人可以把这里当成跳板去扫你家的网络。' +
    `要用自己搭的模型服务，让部署的人在环境变量里设 ${ALLOW_PRIVATE_HOSTS_ENV}=1。`,
  )
}
