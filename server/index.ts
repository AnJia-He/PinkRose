import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { describeConfig, loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { createVault } from './keyvault.ts'
import { SerialQueue } from './queue.ts'
import { redactSecrets } from './sn.ts'
import { createStorage } from './storage.ts'

const ENV_PATH = resolve(process.cwd(), '.env')
if (existsSync(ENV_PATH)) {
  // Node 20.12+ 内置，不需要 dotenv
  process.loadEnvFile(ENV_PATH)
}

const config = loadConfig()

// 账号存在这个库里（users 表）。**全仓库只有这一处**开生产库 ——
// 生产库是进程级单例：同一个文件开两个句柄一点好处都没有（写照样要排队），
// 而"谁是当前用户"这种问题一旦有两个答案，排查起来很贵。
const db = openDb(config.dbPath)

// 图片文件那一层。和上面的库同理：**全仓库只有这一处**建它 ——
// 谁自己再造一个（哪怕用同一个目录），"这张图是怎么存的"就有了第二种说法。
// 根目录来自 config.photoDir（默认 data/photos，同样跟着 cwd 走）。
const storage = createStorage(config.photoDir)

// ⚠️ 全仓库**只有这一处**构造队列实例 —— 三个端点都只从 deps 拿这个注入的对象。
// 谁自己 new 一个，全局串行就静默失效：RPM/TPM 限流保护与对话的因果顺序同时没了。
// onRetry 只打 label / 次数 / 延迟 / error.message，**绝不打印请求头或 key** ——
// 而有些 error.message 里内嵌着上游响应正文（能重试到的那些：429/5xx、还有
// "上游返回的不是 JSON"；401/403 不可重试，来不了这条路），网关回显凭据的毛病
// 不挑状态码：也过一遍 `redactSecrets`（和 http.ts / route.ts / suggest.ts
// 那三个日志出口共用同一个函数）。
const queue = new SerialQueue({
  onRetry: ({ label, attempt, delayMs, error }) =>
    console.warn(`[queue] ${label} 第 ${attempt} 次失败，${delayMs}ms 后重试：${redactSecrets((error as Error).message)}`),
})
// ★ 保险箱的主钥匙**从 SESSION_SECRET 派生**（带用途分隔符，见 keyvault.ts）。
//   不为它多加一个环境变量：多一个变量就多一处"忘了配"，
//   而这里少配的后果是"服务起不来"，那正是 config.ts 对 SESSION_SECRET
//   已经做过的事（没配就拒绝启动）。
//
//   同一个 vault 给下面两个用途：`clients` 开用户那把钥匙、`models` 存用户那把钥匙。
//   两处必须是同一把主钥匙 —— 各 createVault 一次虽然值一样，但"全进程只有一把
//   主钥匙"这件事应当看得出来。
const vault = createVault(config.sessionSecret)

const server = createApp({
  config,
  staticDir: resolve(process.cwd(), 'dist'),
  // ★ 三个 AI 接口要的**默认那一套**（§7）。客户端**不在这里造** ——
  //   每一次请求由 clientFor.ts 的 `resolveClients` 按登录用户现取：
  //   用户刚在设置里换过的那一套，下一个请求就得生效（所以不缓存）。
  //   用户没配（或配了但用不了）时，回落到这里的 `config`：chat 取 vlmModel、
  //   image 取 imageModel —— 两条路各拿自己那个模型名，不再共用一条连接。
  clients: { db, vault, config },
  queue,
  // 签票的钥匙来自 .env（SESSION_SECRET）。config.ts 里少了它就拒绝启动 ——
  // 这里拿到的必然是配置好的那一把，没有"默认值"这条退路。
  auth: { db, secret: config.sessionSecret },
  storage,
  models: { db, vault },
})

// ⚠️ 只听本机（127.0.0.1）。手机走 vite 的代理（代理跑在这台电脑上），
// 所以后端**不需要**出现在局域网上——开出去等于把「没有鉴权、没有限流、
// 但花的是真钱」的接口给整个 wifi 用。
//
// 写 127.0.0.1 而不是 localhost：后者在 Windows 上可能先解析成 IPv6 的 ::1，
// 而这里绑的是 IPv4，会连不上。同一个理由，vite 的代理目标也写成 127.0.0.1。
server.listen(config.port, '127.0.0.1', () => {
  console.log(`RuiXing server  http://127.0.0.1:${config.port}`)
  console.log(`  ${describeConfig(config)}`)
  console.log(`  （只听本机。手机要访问的话，从前端的 ${'5173'} 端口走代理进来）`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  // 库也要一起关：退出前把 sqlite 的 journal 收拾干净，
  // 不留一个"要靠下次启动自己恢复"的状态。
  process.on(sig, () => server.close(() => { db.close(); process.exit(0) }))
}
