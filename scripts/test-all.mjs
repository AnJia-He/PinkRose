#!/usr/bin/env node
/**
 * 稳定的全量测试入口。
 *
 * Vitest 在这台 Windows 开发机上单进程连续跑完 2,600+ 条测试时，会让后面的
 * jsdom 环境退化成 `Object.defineProperty called on non-object` 或单个用例
 * 卡死几十分钟。这里把重型 App 文件各自隔离、其余前端测试切成小批；同一批
 * 单测单独跑都能稳定通过。
 * 有参数时仍然只跑调用方指定的文件，保证 `npm test -- path` 的用法不变。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const requested = process.argv.slice(2)

function testFiles(root) {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(path))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

function chunks(items, size) {
  const out = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

function run(args) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

const frontend = testFiles('src').sort()
const heavyApp = /^src[\\/]App(?:\.[^.\\/]+)?\.test\.tsx$/
const heavy = frontend.filter(file => heavyApp.test(file))
const light = frontend.filter(file => !heavyApp.test(file))
const batches = requested.length > 0
  ? [requested]
  : [
    ...heavy.map(file => [file]),
    ...chunks(light, 28),
    ['server/app.test.ts'],
    [...testFiles('server'), ...testFiles('shared')]
      .filter(file => file !== join('server', 'app.test.ts')),
  ]

for (const batch of batches) {
  // App 级单文件包含几十次完整 App 挂载；Windows 在本机跑完大半个文件后，
  // 单次交互偶尔会超过 Vitest 默认 5 秒。仍保持一次一个文件，只给重型
  // App 批次更宽的 15 秒边界，避免把"进程慢了"误判成行为回归。
  const heavyBatch = batch.some(file => heavyApp.test(file))
  const status = run(heavyBatch ? ['--testTimeout=15000', ...batch] : batch)
  if (status !== 0) process.exit(status)
}
