#!/usr/bin/env node
// Sync shared source files into mini/lib/shared/.
// The mini-program copies are generated; edit the source files and rerun this script.
//
// Usage:
//   node scripts/sync-mini-shared.mjs           # sync six files
//   node scripts/sync-mini-shared.mjs --check   # fail when mirrors are stale
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// [source file, destination filename inside mini]
export const FILES = [
  ['shared/adjustments.ts', 'adjustments.ts'],
  ['shared/lut.ts', 'lut.ts'],
  ['shared/size.ts', 'size.ts'],
  ['src/core/presets.ts', 'presets.ts'],
  ['src/render/shader.ts', 'shader.ts'],
  ['src/render/uniforms.ts', 'uniforms.ts'],
]

// Keep the generated-file warning in the mini-program's existing language while
// keeping this script source ASCII-only for Windows CI parsing.
const HEADER = String.fromCharCode(47,47,32,9888,65039,32,33258,21160,29983,25104,32,8212,8212,32,21247,25913,12290,25913,28304,22836,65288,115,99,114,105,112,116,115,47,115,121,110,99,45,109,105,110,105,45,115,104,97,114,101,100,46,109,106,115,32,30340,32,70,73,76,69,83,32,34920,65289,21518,37325,36305,33050,26412,12290) + '\n'

/** Rewrite imports of shared files to same-directory paths without extensions. */
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
    // Normalize checkout line endings before comparing or writing generated mirrors.
    const source = readFileSync(join(ROOT, src), 'utf8').replace(/\r\n/g, '\n')
    let body = rewriteImports(source, known)
    if (body.includes("from '../")) problems.push(`${out} still contains ../ imports`)
    body = HEADER + body
    const dest = join(outputDir, out)
    if (checkOnly) {
      let existing = null
      try { existing = readFileSync(dest, 'utf8') } catch {}
      if (existing?.replace(/\r\n/g, '\n') !== body) {
        problems.push(`${out} is stale; run the sync script`)
      }
    } else {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(dest, body)
      console.log('[ok]', out)
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  if (checkOnly) console.log('[ok] generated mirrors match the sources')
}

if (process.argv[1] && process.argv[1].endsWith('sync-mini-shared.mjs')) {
  syncFiles(process.argv.includes('--check'))
}
