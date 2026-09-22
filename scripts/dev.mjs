// 同时起 Vite（5173）和后端（8787）。零依赖——不引 concurrently。
import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'
const shell = isWin

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
