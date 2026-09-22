import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { describeConfig, loadConfig } from './config.ts'

const ENV_PATH = resolve(process.cwd(), '.env')
if (existsSync(ENV_PATH)) {
  // Node 20.12+ 内置，不需要 dotenv
  process.loadEnvFile(ENV_PATH)
}

const config = loadConfig()
const server = createApp({ config, staticDir: resolve(process.cwd(), 'dist') })

server.listen(config.port, () => {
  console.log(`RuiXing server  http://localhost:${config.port}`)
  console.log(`  ${describeConfig(config)}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
