/**
 * 用官方自动化驱动**模拟器**跑探针，把结果抓回来。
 *
 * ⚠️ 这跑的是电脑上的模拟器 —— 用的是**电脑的显卡**，不是手机的。
 * 它**回答不了**「手机上跑不跑得动」那个问题。
 * 它的用处只有一个：**把我自己写错的探针筛掉**，让真机那一次尽量干净。
 *
 * 两个坑（都踩过）：
 *   1. `automator.launch()` 内部是 `spawn(cliPath, args)`、**没带 shell: true**，
 *      Windows 上起不了 .bat。改成外面用 PowerShell 起好 CLI（--auto-port 9420），
 *      这里 `connect()` 连上去。
 *   2. `page.callMethod('probeContexts')` 会**等那个跑 10 秒的方法返回**，
 *      默认超时先到，报 "timeout waiting for automator response"。
 *      改成**点按钮**（点了就走），然后轮询页面上的报告。
 *
 * 用法（CLI 要已经起着）：
 *   node spike/miniprogram-webgl/run-probe.cjs
 */
const automator = require('miniprogram-automator')

const ENDPOINT = process.env.WS ?? 'ws://127.0.0.1:9420'
const SHOT = 'D:\\RuiXing\\.superpowers\\simulator.png'
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  console.log('连模拟器', ENDPOINT, '…')
  const mp = await automator.connect({ wsEndpoint: ENDPOINT })
  const page = await mp.currentPage()
  console.log('当前页面:', page.path)

  const buttons = await page.$$('button')
  console.log('页面上的按钮:', buttons.length, '个')

  // 点第一个（① 测 WebGL 能力）。点了就走，不等它跑完。
  await buttons[0].tap()

  // 轮询报告，看到 4096 那一档（或错误）就停
  let report = ''
  for (let i = 0; i < 40; i++) {
    await sleep(2000)
    report = await page.data('report')
    if (/试 4096|拿不到|❌/.test(report)) break
  }

  await mp.screenshot({ path: SHOT })
  console.log('\n===== 页面上的报告 =====')
  console.log(report)
  console.log('\n截图:', SHOT)

  await mp.disconnect()
})().catch(e => {
  console.error('失败:', e && e.message ? e.message : e)
  process.exitCode = 1
})
