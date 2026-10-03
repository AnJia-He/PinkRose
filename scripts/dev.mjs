// 同时起 Vite（5173）和后端（8787）。零依赖——不引 concurrently。
//
// ⚠️ 开跑之前**先看端口**。这条是踩出来的（2026-09-29）：
// Claude 在后台起了一个又没关干净，用户双击「RuiXing 启动」，
// 后端 listen 到 8787 时 EADDRINUSE 崩掉 —— 他看到的是一屏 Node 堆栈，
// 既看不懂也不知道下一步该干嘛。
//
// **这个文件要保证那种画面永远不出现。** 撞端口只有两种可能，
// 两种都得给出人话：不是自己的（报信，别动）／是自己的旧进程（清掉重来）。
import { spawn, execFileSync } from 'node:child_process'

const isWin = process.platform === 'win32'
const shell = isWin

const PORTS = [
  { port: 5173, who: '前端' },
  { port: 8787, who: '后端' },
]

console.log('')
console.log('  RuiXing 正在启动（大约 1~2 秒）')
console.log('  好了之后，浏览器打开这个网址：  http://localhost:5173')
console.log('  这个窗口别关 —— 关掉它就是停止服务。')
console.log('')

// ── 端口上跑的到底是不是我们 ────────────────────────────────
// **不去查进程命令行**：那要拉一次 PowerShell（慢），而且像 `node server/index.ts`
// 这种写法里根本没有项目路径，认不出来。
// 改成**直接问端口上的东西** —— 两个口问的是同一个地址 `/api/health`：
// 8787 由后端自己答，5173 由 vite 的 `/api` 代理转给后端（见 vite.config.ts）。
//
// ⚠️ **2026-10-03 修过一个真 bug**：5173 那一条原来认的是**首页 HTML 里有没有
//   "RuiXing" 四个字**，而产品当天改名 PinkRose（`index.html` 的 title / og:*
//   全换了）—— 于是它**从此永远认不出自己人**：上次的服务还开着时，再双击
//   「启动」会打一句"端口被别的程序占着"然后退出，**根本启动不起来**，
//   而屏幕上那句报信看起来还挺合理，很难怀疑到它头上。
//   教训和 `styles.css` 里那条一样：**探针里的字符串会跟着产品改名腐烂，
//   而且不声不响**。`/api/health` 的答案不跟着名字走，所以现在认它。
async function isOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`,
      { signal: AbortSignal.timeout(1500) })
    if (res.ok && /"ok"\s*:\s*true/.test(await res.text())) return true
  } catch { /* 掉到下面那条兜底 */ }
  if (port !== 5173) return false
  // 兜底：vite 还在、**后端已经死了**（代理会报 500 或干脆连不上）——
  // 那种也是自己人，该清掉重来。认的是 vite 往每个页面里注入的**入口脚本**，
  // 它跟着项目走、不跟着产品名走。
  try {
    const res = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(1500) })
    return res.ok && (await res.text()).includes('/src/main.tsx')
  } catch {
    return false
  }
}

// 谁占着端口。只有 Windows 能用 `netstat -ano` 拿到 PID；
// 这个项目本来就只在 Windows 上跑（启动.cmd / 关防火墙.cmd 都是 .cmd），
// 别的系统上直接跳过这道检查，行为跟以前一样。
function listeners() {
  if (!isWin) return new Map()
  try {
    // 每行长这样：
    //   TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       25924
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const byPort = new Map()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (m) byPort.set(Number(m[1]), Number(m[2]))
    }
    return byPort
  } catch {
    return new Map()
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// taskkill /F 是立即生效的，但 socket 有可能还挂着零点几秒。
// 不等的话，紧接着 spawn 还是会撞上 —— 那就白清一场。
async function waitFree(ports, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = listeners()
    if (ports.every(p => !busy.has(p))) return true
    await sleep(120)
  }
  return false
}

async function maybeClearOld() {
  const busy = listeners()
  const mine = []
  const theirs = []

  for (const { port, who } of PORTS) {
    if (!busy.has(port)) continue
    // 串行问，别并发 —— 这两次探测都是本地请求，差不了几毫秒
    if (await isOurs(port)) mine.push({ port, who, pid: busy.get(port) })
    else theirs.push({ port, who, pid: busy.get(port) })
  }

  if (theirs.length) {
    console.log('  ⚠️ 起不来：端口被别的程序占着。')
    console.log('')
    for (const { port, who, pid } of theirs) {
      console.log(`     ${port}（${who}）被 PID ${pid} 占着`)
    }
    console.log('')
    console.log('     这个不是 RuiXing 自己的进程，我**没有**动它。')
    console.log('     把那个程序关掉，再双击一次这个文件就行。')
    console.log('')
    process.exit(1)
  }

  if (mine.length) {
    console.log('  上一次的 RuiXing 还开着（没关干净），先清掉它：')
    for (const { port, who, pid } of mine) {
      console.log(`     ${port}（${who}）  PID ${pid}`)
    }
    // 只杀其中一个其实就会级联 —— 旧的那份 dev.mjs 看见子进程退出会自己
    // 把另一个也收掉（见下面 p.on('exit')）。全杀一遍只是别指望这条。
    for (const { pid } of mine) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    await waitFree(mine.map(m => m.port))
    console.log('     清完了，重新起一个干净的。')
    console.log('')
  }
}

await maybeClearOld()

// ⚠️ 命令和参数**拼成一个字符串**再交给 shell，别用 `spawn(cmd, args, { shell: true })`。
// 那种写法在 Node 24 上会打一条黄字 DeprecationWarning（DEP0190：
// "Passing args to a child process with shell option true…"）—— 又长又吓人，
// 而它**只是说写法过时了，不是出错了**。用户看不懂就会截图来问。
// 拼字符串既没有这条告警，也不损失什么：这里两个命令都是写死的常量，没有注入面。
function run(name, cmdline) {
  const p = spawn(cmdline, { shell, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = (line) => process.stdout.write(`[${name}] ${line}`)
  p.stdout.on('data', d => tag(d))
  p.stderr.on('data', d => tag(d))
  p.on('exit', code => {
    console.log(`[${name}] 退出，码 ${code}`)
    shutdown(code ?? 0)
  })
  return p
}

const procs = [
  run('vite  ', 'npx vite'),
  run('server', 'node server/index.ts'),
]

let closing = false
function shutdown(code) {
  if (closing) return
  closing = true
  for (const p of procs) { try { p.kill() } catch {} }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
