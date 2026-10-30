#!/usr/bin/env node
/** 检查生产首包和稳定依赖是否仍按预算拆分。 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../dist/assets/', import.meta.url)
const files = readdirSync(ROOT)
const js = files.filter(name => name.endsWith('.js'))
const main = js.find(name => /^index-.*\.js$/.test(name))
const size = name => statSync(new URL(name, ROOT)).size
const kib = bytes => `${(bytes / 1024).toFixed(1)} KB`
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

check('生产构建存在主包', !!main, main ?? 'missing')
if (main) {
  const bytes = size(main)
  check('首包不超过 1 MB 预算', bytes <= 1_000_000, kib(bytes))
}
for (const [name, prefix] of [
  ['React / Base UI', 'react-vendor-'],
  ['图标', 'icons-vendor-'],
  ['EXIF', 'exif-vendor-'],
  ['批量处理工作流', 'BatchPanel-'],
  ['短片调色工作流', 'VideoPanel-'],
  ['照片电影工作流', 'PhotoMoviePanel-'],
  ['九宫格工作流', 'GridSplitPanel-'],
  ['实时相机', 'CameraCapture-'],
  ['相机桥', 'CameraBridge-'],
]) {
  const chunk = js.find(file => file.startsWith(prefix))
  check(`${name}已拆成可缓存块`, !!chunk, chunk ? kib(size(chunk)) : 'missing')
}

const failed = checks.filter(item => !item.ok)
if (failed.length) process.exitCode = 1
