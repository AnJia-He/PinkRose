import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { describeConfig, loadConfig } from './config.ts'
import { SerialQueue } from './queue.ts'
import { SenseNovaClient } from './sn.ts'

const ENV_PATH = resolve(process.cwd(), '.env')
if (existsSync(ENV_PATH)) {
  // Node 20.12+ 内置，不需要 dotenv
  process.loadEnvFile(ENV_PATH)
}

const config = loadConfig()

// ⚠️ 全仓库**只有这一处**构造队列实例 —— 三个端点都只从 deps 拿这个注入的对象。
// 谁自己 new 一个，全局串行就静默失效：RPM/TPM 限流保护与对话的因果顺序同时没了。
// onRetry 只打 label / 次数 / 延迟 / error.message，**绝不打印请求头或 key**。
const queue = new SerialQueue({
  onRetry: ({ label, attempt, delayMs, error }) =>
    console.warn(`[queue] ${label} 第 ${attempt} 次失败，${delayMs}ms 后重试：${(error as Error).message}`),
})
const client = new SenseNovaClient(config)

const server = createApp({
  config,
  staticDir: resolve(process.cwd(), 'dist'),
  client,
  queue,
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
  process.on(sig, () => server.close(() => process.exit(0)))
}
