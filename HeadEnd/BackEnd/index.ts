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

server.listen(config.port, () => {
  console.log(`RuiXing server  http://localhost:${config.port}`)
  console.log(`  ${describeConfig(config)}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
