// 桌面版最小启动验收：用与安装包相同的服务 bundle 启动一个临时实例，
// 确认静态前端、健康接口、安全响应头和独立数据目录都真的可用。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const required = [
  'electron/main.mjs',
  'electron/preload.cjs',
  'electron-builder.yml',
  'build-server/server.cjs',
  'build-server/searchMcp.cjs',
  'dist/app.html',
]
const missing = required.filter(path => !existsSync(join(root, path)))
if (missing.length > 0) {
  throw new Error(`桌面构建缺少文件：${missing.join('、')}`)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.main !== 'electron/main.mjs') {
  throw new Error('package.json 的 main 没有指向 Electron 主进程')
}

const dataRoot = await mkdtemp(join(tmpdir(), 'pinkrose-desktop-check-'))
await mkdir(join(dataRoot, 'photos'), { recursive: true })
await mkdir(join(dataRoot, 'luts'), { recursive: true })
const port = 47991
const child = spawn(process.execPath, [join(root, 'build-server', 'server.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    PINKROSE_DESKTOP: '1',
    PORT: String(port),
    SESSION_SECRET: 'desktop-check-only-not-production',
    DB_PATH: join(dataRoot, 'pinkrose.db'),
    PHOTO_DIR: join(dataRoot, 'photos'),
    LUT_DIR: join(dataRoot, 'luts'),
    AGNES_API_KEY: '',
    SN_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let logs = ''
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })

async function waitForServer() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`桌面服务提前退出（${child.exitCode}）：${logs.slice(-2000)}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return
    } catch {
      // 启动中，继续等。
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  throw new Error('桌面服务启动超时')
}

try {
  await waitForServer()
  const app = await fetch(`http://127.0.0.1:${port}/app`)
  if (!app.ok) throw new Error(`应用页返回 ${app.status}`)
  const html = await app.text()
  if (!html.includes('PinkRose')) throw new Error('应用页没有加载 PinkRose 前端')
  const csp = app.headers.get('content-security-policy') ?? ''
  if (!csp.includes("default-src 'self'") || !csp.includes("object-src 'none'")) {
    throw new Error('安全响应头没有生效')
  }
  const entries = await readdir(dataRoot)
  if (!entries.some(name => name.endsWith('.db'))) {
    throw new Error('独立数据目录里没有创建数据库')
  }
  console.log(`桌面服务启动通过：${html.length} 字符前端、CSP 生效、数据目录可写（${entries.join(', ')}）`)
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolveExit => {
      child.once('exit', resolveExit)
      setTimeout(resolveExit, 4_000).unref()
    })
  }
  await rm(dataRoot, { recursive: true, force: true })
}
