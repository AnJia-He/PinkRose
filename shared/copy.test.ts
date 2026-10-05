import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LUT_FILE_TOO_BIG, LUT_LIMIT_REACHED } from './copy.ts'
import { MAX_LUT_FILE_BYTES, MAX_LUTS } from './lut.ts'

/**
 * ★ 2026-10-05 终审修复：滤镜那两句**界面和服务端都要说**的话
 * （`src/ui/LutSettings.tsx` / `server/luts.ts`）各写一份 —— 那是仓库硬线不让的
 * （见 `copy.ts` 开头那段：改了一边，另一边就变成对同一个毛病"另一种说法"，
 * 而这件事**没有任何报错**）。
 *
 * 这个文件干两件事：
 *   · 把那两句话的**成品样子**钉住（它们就是用户看到的字，别再变）；
 *   · 钉住**调用点没有自己抄一份** —— 这条没了的话，"收进 copy.ts"今天做了、
 *     明天有人顺手内联回去，一样是静默的（既有测试断的是那句字面量，
 *     两边抄成一样的仍然绿）。
 */
describe('两边都要说的那两句（滤镜）', () => {
  it('数字来自 MAX_LUT_FILE_BYTES / MAX_LUTS —— 不是抄的，改了上限这句话不会撒谎', () => {
    expect(LUT_FILE_TOO_BIG(MAX_LUT_FILE_BYTES)).toBe('这个文件超过 8 MB 了。')
    expect(LUT_LIMIT_REACHED(MAX_LUTS)).toBe('最多 30 个 Lut，先删掉几个再导入。')
  })

  it('界面和服务端都 import，没有哪一边自己抄一份', () => {
    // ⚠️ 路径从**这个文件**算（`new URL(..., import.meta.url)`）—— jsdom 环境里
    //   拼出来不是 `file://`，`readFileSync` 会当场报（`AdjustmentPanel.test.ts`
    //   里记过同一个坑）。这个文件跑在 node 环境，但仍然照那条写法走。
    for (const rel of ['../src/ui/LutSettings.tsx', '../server/luts.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      expect(src, `${rel} 里抄了"超过 8 MB"那句`).not.toContain('超过 8 MB')
      expect(src, `${rel} 里抄了"最多 N 个 Lut"那句`).not.toContain('先删掉几个再导入')
    }
  })
})
