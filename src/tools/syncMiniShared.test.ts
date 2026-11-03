import { describe, it, expect } from 'vitest'
import { rewriteImports } from './syncMiniShared.ts'

/**
 * 同步脚本是「共享文件的唯一真相源」的可执行形式：小程序侧的 `mini/lib/shared/`
 * 是**生成物**，里面只允许同目录引用（小程序打包器走不了 `../`）。这三条钉的是
 * 改写规则本身 —— 路径从哪来、改到哪去、不认识的东西不许碰。
 */

const KNOWN = ['adjustments.ts', 'lut.ts', 'size.ts', 'presets.ts', 'shader.ts', 'uniforms.ts']

describe('rewriteImports', () => {
  it('把指向共享文件的多级相对路径改成同目录无后缀', () => {
    const src = `import { toUnit } from '../../shared/adjustments.ts'\nimport type { Cube } from '../../shared/lut.ts'\n`
    expect(rewriteImports(src, KNOWN)).toBe(
      `import { toUnit } from './adjustments'\nimport type { Cube } from './lut'\n`)
  })
  it('镜像里不许残留任何 "../"', () => {
    const src = `import { X } from '../../../weird/adjustments.ts'`
    const out = rewriteImports(src, KNOWN)
    expect(out).not.toContain('..')
    expect(out).toContain("'./adjustments'")
  })
  it('不认识的文件原样保留', () => {
    const src = `import { join } from 'node:path'`
    expect(rewriteImports(src, KNOWN)).toBe(src)
  })
})
