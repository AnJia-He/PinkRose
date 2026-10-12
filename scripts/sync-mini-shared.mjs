#!/usr/bin/env node
// 把电脑版里的「单一真相源」文件同步进 mini/lib/shared/。
// ⚠️ 这些文件是小程序的**生成物**，别在 mini 里改它们 —— 改源头，重跑本脚本。
//
// 用法：
//   node scripts/sync-mini-shared.mjs           # 同步（写出 6 个文件，逐个打 ✓）
//   node scripts/sync-mini-shared.mjs --check   # 守卫：镜像与源头不一致就退出码 1
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// [源文件, 在 mini 里的文件名]
export const FILES = [
  ['shared/adjustments.ts', 'adjustments.ts'],
  ['shared/lut.ts', 'lut.ts'],
  ['shared/size.ts', 'size.ts'],
  ['src/core/presets.ts', 'presets.ts'],
  ['src/render/shader.ts', 'shader.ts'],
  ['src/render/uniforms.ts', 'uniforms.ts'],
]

const HEADER = '// ⚠️ 自动生成 —— 勿改。改源头（scripts/sync-mini-shared.mjs 的 FILES 表）后重跑脚本。\n'

/** 把 import 里指向共享文件的路径改写为同目录、无后缀。 */
export function rewriteImports(source, knownNames) {
  return source.replace(
    /(from\s+['"])([^'"]+)(['"])/g,
    (whole, a, spec, c) => {
      const base = spec.split('/').pop()
      if (!knownNames.includes(base)) return whole
      const noExt = base.replace(/\.ts$/, '')
      return `${a}./${noExt}${c}`
    },
  )
}

export function syncFiles(checkOnly = false) {
  const outputDir = join(ROOT, 'mini', 'lib', 'shared')
  const known = FILES.map(([, out]) => out)
  const problems = []
  for (const [src, out] of FILES) {
    const source = readFileSync(join(ROOT, src), 'utf8')
    let body = rewriteImports(source, known)
    if (body.includes("from '../")) problems.push(`${out} 里残留 ../ 相对路径`)
    body = HEADER + body
    const dest = join(outputDir, out)
    if (checkOnly) {
      let existing = null
      try { existing = readFileSync(dest, 'utf8') } catch {}
      if (existing !== body) problems.push(`${out} 与源头不一致（跑一遍同步）`)
    } else {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(dest, body)
      console.log('✓', out)
    }
  }
  // ★ 与 brief 的差别：同步模式曾经只把 problems 收进数组就丢掉 ——
  //   一旦某个源头文件 import 了 FILES 表外的共享文件（残留 ../），
  //   镜像悄悄写坏、屏幕上还全是 ✓。这里的规矩是"坏消息必须出声"。
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  if (checkOnly) console.log('✓ 镜像与源头一致')
}

if (process.argv[1] && process.argv[1].endsWith('sync-mini-shared.mjs')) {
  syncFiles(process.argv.includes('--check'))
}
