// 同时起 Vite（5173）和后端（8787）。零依赖——不引 concurrently。
import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'
const shell = isWin

// 给不敲命令的人看的：窗口里直接说清「好了之后点哪儿」。
// 由 Node 打印（UTF-8），不经过 cmd 的代码页，所以中文一定不会花。
console.log('')
console.log('  RuiXing 正在启动（大约 1~2 秒）')
console.log('  好了之后，浏览器打开这个网址：  http://localhost:5173')
console.log('  这个窗口别关 —— 关掉它就是停止服务。')
console.log('')

const procs = [
  { name: 'vite  ', cmd: 'npx', args: ['vite'] },
  { name: 'server', cmd: 'node', args: ['server/index.ts'] },
].map(({ name, cmd, args }) => {
  const p = spawn(cmd, args, { shell, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = (line) => process.stdout.write(`[${name}] ${line}`)
  p.stdout.on('data', d => tag(d))
  p.stderr.on('data', d => tag(d))
  p.on('exit', code => {
    console.log(`[${name}] 退出，码 ${code}`)
    shutdown(code ?? 0)
  })
  return p
})

let closing = false
function shutdown(code) {
  if (closing) return
  closing = true
  for (const p of procs) { try { p.kill() } catch {} }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
