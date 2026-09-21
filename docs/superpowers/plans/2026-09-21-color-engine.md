# 本地调色引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个能在浏览器里实时调色的引擎——上传照片，拖八个滑块，毫秒级看到结果，导出。

**Architecture:** 调色数学写成一个纯 TypeScript 模块（可单元测试），WebGL2 片段着色器是它的高性能移植版（供实时预览）。着色器只有一个 pass，八个参数一次算完。React 只管 UI 和状态，不碰像素。

**Tech Stack:** Vite + React 18 + TypeScript；Vitest 做测试；WebGL2 原生 API（不引第三方图形库）。

**Spec:** `docs/superpowers/specs/2026-09-21-ruixing-conversational-editing-design.md`（本计划实现其中的 §5 本地调色引擎，以及 §4.4 尺寸策略中"调色走原图尺寸"那一半）

## Global Constraints

- **参数取值范围**：所有 `Adjustments` 字段归一化到 `[-100, 100]`，越界必须 clamp（spec §3.4 / §5.1）
- **八个参数名固定**：`exposure`、`contrast`、`highlights`、`shadows`、`saturation`、`temperature`、`clarity`、`vignette`（spec §5.1）
- **色彩管理**：内部统一 sRGB。iPhone 的 Display P3 照片解码时必须转换，否则颜色会偏（spec §5.3）
- **导出保留 EXIF**（spec §5.4）
- **调色不缩图**：调色路径使用原图分辨率，不经过任何缩放（spec §4.4）
- **渲染只有一个 pass**：八个参数在同一个 fragment shader 里算完，不串多个 pass（spec §5.2）
- **本计划不涉及**：后端、SenseNova API、对话、意图路由、生成式编辑。那些属于计划二。

---

## 文件结构

```
D:\RuiXing\
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── src/
    ├── main.tsx                  入口，挂载 React
    ├── App.tsx                   页面骨架，串起上传/画布/面板
    ├── styles.css                全局样式
    ├── core/
    │   ├── adjustments.ts        八参数类型、默认值、clamp、增量合并
    │   ├── adjustments.test.ts
    │   ├── tone.ts               调色数学（纯 TS 参考实现）
    │   ├── tone.test.ts
    │   ├── presets.ts            一键风格预设
    │   └── presets.test.ts
    ├── image/
    │   ├── decode.ts             解码、P3→sRGB、尺寸处理
    │   └── decode.test.ts
    ├── render/
    │   ├── shader.ts             GLSL 源码（tone.ts 的移植）
    │   └── pipeline.ts           WebGL2 渲染器
    └── ui/
        ├── Canvas.tsx            画布，负责把渲染结果贴上去
        ├── AdjustmentPanel.tsx   八滑块 UI
        └── Uploader.tsx          选文件 + 解码入口
```

**为什么 `tone.ts` 和 `shader.ts` 是两份代码：** 着色器没法单元测试，但调色数学不测就是赌。所以数学在 TS 里写一份、测透，着色器是它的高性能移植；再写一个集成测试比对两者的输出，防止漂移。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: 无
- Produces: 一个能 `npm run dev` 起来、`npm test` 能跑通的空壳项目

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "ruixing",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^2.1.8",
    "jsdom": "^25.0.1"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: 写 `vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 5: 写 `index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RuiXing</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: 写 `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 7: 写 `src/App.tsx`（占位版）**

```tsx
export default function App() {
  return <div className="app">RuiXing</div>
}
```

- [ ] **Step 8: 写 `src/styles.css`**

```css
:root {
  color-scheme: dark;
  --bg: #14161a;
  --panel: #1d2026;
  --text: #e8eaed;
  --muted: #9aa0a6;
  --accent: #4c8dff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
}

.app {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: var(--muted);
}
```

- [ ] **Step 9: 装依赖并跑起来**

```bash
npm install
npm run dev
```

预期：终端打印出 `http://localhost:5173/`，浏览器打开看到深色页面中间写着 `RuiXing`。

- [ ] **Step 10: 验证测试命令能跑（此时还没有测试文件，Vitest 会以退出码 1 提示"没找到测试"）**

```bash
npx vitest run --passWithNoTests
```

预期：`No test files found`，退出码 0。

- [ ] **Step 11: 写 `.gitignore` 补充**（文件已存在，确认包含以下行，缺则补）

```
node_modules/
dist/
```

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts index.html src .gitignore
git commit -m "chore: Vite + React + TypeScript + Vitest 脚手架"
```

---

### Task 2: 调色参数模型（纯逻辑）

**Files:**
- Create: `src/core/adjustments.ts`, `src/core/adjustments.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Adjustments = { exposure: number; contrast: number; highlights: number; shadows: number; saturation: number; temperature: number; clarity: number; vignette: number }`
  - `const ZERO: Adjustments` — 全 0
  - `const PARAM_KEYS: readonly (keyof Adjustments)[]`
  - `clampAdjustments(a: Adjustments): Adjustments` — 每个字段钳到 `[-100, 100]`
  - `applyDeltas(base: Adjustments, deltas: Partial<Adjustments>): Adjustments` — 相加后钳制
  - `toUnit(a: Adjustments): Record<keyof Adjustments, number>` — 换算到 `[-1, 1]`，供着色器使用

- [ ] **Step 1: 写失败测试 `src/core/adjustments.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { ZERO, PARAM_KEYS, clampAdjustments, applyDeltas, toUnit } from './adjustments'

describe('PARAM_KEYS', () => {
  it('固定八个参数，名字不能改', () => {
    expect(PARAM_KEYS).toEqual([
      'exposure', 'contrast', 'highlights', 'shadows',
      'saturation', 'temperature', 'clarity', 'vignette',
    ])
  })
})

describe('ZERO', () => {
  it('八个字段全为 0', () => {
    for (const k of PARAM_KEYS) expect(ZERO[k]).toBe(0)
  })
})

describe('clampAdjustments', () => {
  it('把越界值钳到 [-100, 100]', () => {
    const out = clampAdjustments({ ...ZERO, exposure: 150, contrast: -220, shadows: 30 })
    expect(out.exposure).toBe(100)
    expect(out.contrast).toBe(-100)
    expect(out.shadows).toBe(30)
  })

  it('不改动入参（纯函数）', () => {
    const input = { ...ZERO, exposure: 999 }
    clampAdjustments(input)
    expect(input.exposure).toBe(999)
  })
})

describe('applyDeltas', () => {
  it('增量叠加到当前值上', () => {
    const base = { ...ZERO, temperature: -20 }
    const out = applyDeltas(base, { temperature: 15 })
    expect(out.temperature).toBe(-5)
  })

  it('叠加后仍钳制在范围内', () => {
    const out = applyDeltas({ ...ZERO, exposure: 90 }, { exposure: 50 })
    expect(out.exposure).toBe(100)
  })

  it('只动传入的字段，其余保持不变', () => {
    const base = { ...ZERO, saturation: 40, vignette: -10 }
    const out = applyDeltas(base, { exposure: 10 })
    expect(out.saturation).toBe(40)
    expect(out.vignette).toBe(-10)
  })
})

describe('toUnit', () => {
  it('-100 -> -1，100 -> 1，0 -> 0', () => {
    const u = toUnit({ ...ZERO, exposure: -100, contrast: 100, shadows: 0 })
    expect(u.exposure).toBe(-1)
    expect(u.contrast).toBe(1)
    expect(u.shadows).toBe(0)
  })

  it('中间值线性映射（50 -> 0.5）', () => {
    expect(toUnit({ ...ZERO, saturation: 50 }).saturation).toBe(0.5)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/core/adjustments.test.ts
```

预期：FAIL，报错 `Failed to resolve import "./adjustments"`。

- [ ] **Step 3: 写实现 `src/core/adjustments.ts`**

```ts
export type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  saturation: number
  temperature: number
  clarity: number
  vignette: number
}

export const PARAM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows',
  'saturation', 'temperature', 'clarity', 'vignette',
] as const satisfies readonly (keyof Adjustments)[]

export const ZERO: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, clarity: 0, vignette: 0,
}

/** 参数统一范围：[-100, 100] */
export const PARAM_MIN = -100
export const PARAM_MAX = 100

const clampOne = (v: number): number =>
  Math.max(PARAM_MIN, Math.min(PARAM_MAX, v))

/** 把八个字段各自钳到 [-100, 100]。纯函数，不改入参。 */
export function clampAdjustments(a: Adjustments): Adjustments {
  return {
    exposure: clampOne(a.exposure),
    contrast: clampOne(a.contrast),
    highlights: clampOne(a.highlights),
    shadows: clampOne(a.shadows),
    saturation: clampOne(a.saturation),
    temperature: clampOne(a.temperature),
    clarity: clampOne(a.clarity),
    vignette: clampOne(a.vignette),
  }
}

/**
 * 把增量叠加到当前值上，再整体钳制。
 *
 * 为什么用增量而不是绝对值：LLM 做算术是经典翻车点。
 * 让它说"再暖一点 = +20"，累加和钳制交给这里的确定性代码。
 */
export function applyDeltas(base: Adjustments, deltas: Partial<Adjustments>): Adjustments {
  const out = { ...base }
  for (const k of PARAM_KEYS) {
    const d = deltas[k]
    if (typeof d === 'number') out[k] = out[k] + d
  }
  return clampAdjustments(out)
}

/** 换算到 [-1, 1]，供着色器 uniform 使用。 */
export function toUnit(a: Adjustments): Record<keyof Adjustments, number> {
  const c = clampAdjustments(a)
  return {
    exposure: c.exposure / 100,
    contrast: c.contrast / 100,
    highlights: c.highlights / 100,
    shadows: c.shadows / 100,
    saturation: c.saturation / 100,
    temperature: c.temperature / 100,
    clarity: c.clarity / 100,
    vignette: c.vignette / 100,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx vitest run src/core/adjustments.test.ts
```

预期：PASS，约 9 个断言组全绿。

- [ ] **Step 5: Commit**

```bash
git add src/core/adjustments.ts src/core/adjustments.test.ts
git commit -m "feat(core): 八参数模型、钳制、增量合并"
```

---

### Task 3: 调色数学（纯 TS 参考实现）

**Files:**
- Create: `src/core/tone.ts`, `src/core/tone.test.ts`

**Interfaces:**
- Consumes: `Adjustments`, `toUnit`（Task 2）
- Produces:
  - `type Unit = Record<keyof Adjustments, number>`
  - `type RGB = [number, number, number]`
  - `srgbToLinear(c: number): number` / `linearToSrgb(c: number): number`
  - `luma(r: number, g: number, b: number): number`
  - `clamp01(v: number): number`
  - `applyTone(rgb: RGB, u: Unit): RGB` — 输入输出均为 `[0, 1]` 区间的 sRGB 值

**为什么这份实现存在：** 着色器无法单元测试，这份 TS 实现是它的"标准答案"。两边的输出必须一致（Task 5 会做比对测试）。

- [ ] **Step 1: 写失败测试 `src/core/tone.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { ZERO, toUnit } from './adjustments'
import { applyTone, srgbToLinear, linearToSrgb } from './tone'

const mid: [number, number, number] = [0.5, 0.5, 0.5]
const U = toUnit(ZERO)

describe('sRGB 线性化往返', () => {
  it('往返后基本还原', () => {
    for (const v of [0, 0.04, 0.2, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 5)
    }
  })
})

describe('applyTone', () => {
  it('全零参数不改变颜色', () => {
    const out = applyTone([0.3, 0.6, 0.9], U)
    expect(out[0]).toBeCloseTo(0.3, 3)
    expect(out[1]).toBeCloseTo(0.6, 3)
    expect(out[2]).toBeCloseTo(0.9, 3)
  })

  it('曝光 +100 让中灰明显变亮', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, exposure: 100 }))
    expect(out[0]).toBeGreaterThan(0.6)
  })

  it('曝光 -100 让中灰明显变暗', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, exposure: -100 }))
    expect(out[0]).toBeLessThan(0.4)
  })

  it('对比度 +100 把亮部推更亮、暗部推更暗', () => {
    const dark = applyTone([0.25, 0.25, 0.25], toUnit({ ...ZERO, contrast: 100 }))
    const light = applyTone([0.75, 0.75, 0.75], toUnit({ ...ZERO, contrast: 100 }))
    expect(dark[0]).toBeLessThan(0.25)
    expect(light[0]).toBeGreaterThan(0.75)
  })

  it('对比度 +100 时中灰不动（支点在中灰）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, contrast: 100 }))
    expect(out[0]).toBeCloseTo(0.5, 2)
  })

  it('饱和度 -100 把颜色压成灰（三通道相等）', () => {
    const out = applyTone([0.9, 0.3, 0.1], toUnit({ ...ZERO, saturation: -100 }))
    expect(out[0]).toBeCloseTo(out[1], 3)
    expect(out[1]).toBeCloseTo(out[2], 3)
  })

  it('饱和度 +50 让原本就鲜艳的颜色更鲜艳', () => {
    const before = [0.8, 0.4, 0.2] as [number, number, number]
    const out = applyTone(before, toUnit({ ...ZERO, saturation: 50 }))
    const spreadBefore = Math.max(...before) - Math.min(...before)
    const spreadAfter = Math.max(...out) - Math.min(...out)
    expect(spreadAfter).toBeGreaterThan(spreadBefore)
  })

  it('色温 +100 让画面偏暖（红升蓝降）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, temperature: 100 }))
    expect(out[0]).toBeGreaterThan(out[2])
  })

  it('色温 -100 让画面偏冷（蓝升红降）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, temperature: -100 }))
    expect(out[2]).toBeGreaterThan(out[0])
  })

  it('高光 +100 主要提亮亮部，暗部几乎不动', () => {
    const light = applyTone([0.85, 0.85, 0.85], toUnit({ ...ZERO, highlights: 100 }))
    const dark = applyTone([0.2, 0.2, 0.2], toUnit({ ...ZERO, highlights: 100 }))
    expect(light[0] - 0.85).toBeGreaterThan(0.05)
    expect(Math.abs(dark[0] - 0.2)).toBeLessThan(0.02)
  })

  it('阴影 +100 主要提亮暗部，亮部几乎不动', () => {
    const dark = applyTone([0.2, 0.2, 0.2], toUnit({ ...ZERO, shadows: 100 }))
    const light = applyTone([0.85, 0.85, 0.85], toUnit({ ...ZERO, shadows: 100 }))
    expect(dark[0] - 0.2).toBeGreaterThan(0.05)
    expect(Math.abs(light[0] - 0.85)).toBeLessThan(0.02)
  })

  it('输出永远落在 [0, 1] 内（极端参数也不越界）', () => {
    const extreme = toUnit({
      exposure: 100, contrast: 100, highlights: 100, shadows: 100,
      saturation: 100, temperature: 100, clarity: 100, vignette: 100,
    })
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.9]] as const) {
      const out = applyTone(rgb as [number, number, number], extreme)
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/core/tone.test.ts
```

预期：FAIL，`Failed to resolve import "./tone"`。

- [ ] **Step 3: 写实现 `src/core/tone.ts`**

```ts
import type { Adjustments } from './adjustments'

export type Unit = Record<keyof Adjustments, number>
export type RGB = [number, number, number]

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

export const luma = (r: number, g: number, b: number): number =>
  LUMA_R * r + LUMA_G * g + LUMA_B * b

/** sRGB -> 线性光。曝光/明暗运算必须在线性空间做，否则结果发灰。 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * 六个「与像素位置无关」的参数依次作用在一个 sRGB 颜色上：
 * 色温 → 曝光 → 高光/阴影 → 对比度 → 饱和度。
 *
 * 另外两个参数**故意不在这里**：
 *   - 清晰度（clarity）需要邻域像素的模糊值
 *   - 暗角（vignette）需要像素在画面中的坐标
 * 单像素函数表达不了它们，两者只在 render/shader.ts 里做全图版本。
 *
 * 本函数的运算顺序与 render/shader.ts 的 GLSL 实现严格一致，
 * 改一边必须同步改另一边。
 */
export function applyTone(rgb: RGB, u: Unit): RGB {
  let [r, g, b] = rgb

  // 1. 色温：暖 = 抬红压蓝（sRGB 空间近似，够用且可预测）
  r += u.temperature * 0.10
  b -= u.temperature * 0.10

  // 2. 曝光：线性空间乘 2^ev
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b)
  const ev = Math.pow(2, u.exposure)
  r *= ev; g *= ev; b *= ev
  r = linearToSrgb(r); g = linearToSrgb(g); b = linearToSrgb(b)

  // 3. 高光 / 阴影：按亮度加权
  const l = luma(r, g, b)
  const hiW = smoothstep(0.5, 1.0, l) * 0.35 * u.highlights
  const loW = (1 - smoothstep(0.0, 0.5, l)) * 0.35 * u.shadows
  r += hiW + loW; g += hiW + loW; b += hiW + loW

  // 4. 对比度：围绕中灰支点
  const cScale = 1 + u.contrast
  r = (r - 0.5) * cScale + 0.5
  g = (g - 0.5) * cScale + 0.5
  b = (b - 0.5) * cScale + 0.5

  // 5. 饱和度：朝亮度灰点插值
  const l2 = luma(r, g, b)
  const sat = 1 + u.saturation
  r = l2 + (r - l2) * sat
  g = l2 + (g - l2) * sat
  b = l2 + (b - l2) * sat

  return [clamp01(r), clamp01(g), clamp01(b)]
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
```

> **注意**：`applyTone` 只覆盖**六个**与像素位置无关的参数——色温、曝光、高光、阴影、对比度、饱和度。
>
> **清晰度和暗角不在其中**：暗角依赖像素在画面中的位置（到中心的距离），清晰度依赖邻域像素，单像素函数表达不了这两个。它们只在着色器里做全图版本。
>
> 因此着色器与 TS 实现的比对**只针对上面这六个参数**；清晰度和暗角靠 Task 7 的浏览器验收用眼睛确认。

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx vitest run src/core/tone.test.ts
```

预期：PASS，全部 13 组断言绿。

- [ ] **Step 5: Commit**

```bash
git add src/core/tone.ts src/core/tone.test.ts
git commit -m "feat(core): 调色数学参考实现（八参数、线性空间曝光）"
```

---

### Task 4: 一键风格预设

**Files:**
- Create: `src/core/presets.ts`, `src/core/presets.test.ts`

**Interfaces:**
- Consumes: `Adjustments`, `ZERO`, `clampAdjustments`（Task 2）
- Produces:
  - `type Preset = { id: string; label: string; adjustments: Adjustments }`
  - `const PRESETS: readonly Preset[]`

- [ ] **Step 1: 写失败测试 `src/core/presets.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { PRESETS } from './presets'
import { PARAM_KEYS } from './adjustments'

describe('PRESETS', () => {
  it('至少 5 个预设', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5)
  })

  it('id 唯一', () => {
    const ids = PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个预设都有中文标签', () => {
    for (const p of PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.label).toMatch(/[\u4e00-\u9fa5]/)
    }
  })

  it('每个预设有完整的八个字段，且都在 [-100, 100] 内', () => {
    for (const p of PRESETS) {
      for (const k of PARAM_KEYS) {
        expect(typeof p.adjustments[k]).toBe('number')
        expect(p.adjustments[k]).toBeGreaterThanOrEqual(-100)
        expect(p.adjustments[k]).toBeLessThanOrEqual(100)
      }
    }
  })

  it('预设之间不是完全相同的', () => {
    const seen = new Set(PRESETS.map(p => JSON.stringify(p.adjustments)))
    expect(seen.size).toBe(PRESETS.length)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/core/presets.test.ts
```

预期：FAIL，`Failed to resolve import "./presets"`。

- [ ] **Step 3: 写实现 `src/core/presets.ts`**

```ts
import { ZERO, type Adjustments } from './adjustments'

export type Preset = {
  id: string
  label: string
  adjustments: Adjustments
}

/**
 * 一键风格 = 一组预设好的八参数值。
 * 不需要单独的引擎——应用预设就是把这组值直接赋给 params。
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'jp-clean',
    label: '日系通透',
    adjustments: { ...ZERO, exposure: 8, contrast: -6, shadows: 22, saturation: -12, temperature: -14, clarity: 8 },
  },
  {
    id: 'film',
    label: '胶片',
    adjustments: { ...ZERO, exposure: -4, contrast: -14, highlights: -18, shadows: 18, saturation: -18, temperature: 8, clarity: -10, vignette: 18 },
  },
  {
    id: 'golden',
    label: '黄昏',
    adjustments: { ...ZERO, exposure: 4, contrast: 12, highlights: -10, shadows: 10, saturation: 14, temperature: 32, clarity: 6, vignette: 12 },
  },
  {
    id: 'bright',
    label: '通透提亮',
    adjustments: { ...ZERO, exposure: 16, contrast: 8, highlights: -20, shadows: 26, saturation: 6, clarity: 14 },
  },
  {
    id: 'moody',
    label: '暗调氛围',
    adjustments: { ...ZERO, exposure: -10, contrast: 20, highlights: -24, shadows: -12, saturation: -10, temperature: -10, vignette: 30 },
  },
  {
    id: 'vivid',
    label: '鲜艳',
    adjustments: { ...ZERO, contrast: 14, saturation: 28, clarity: 16, vignette: 8 },
  },
]
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx vitest run src/core/presets.test.ts
```

预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/presets.ts src/core/presets.test.ts
git commit -m "feat(core): 一键风格预设"
```

---

### Task 5: 图像解码与尺寸处理

**Files:**
- Create: `src/image/decode.ts`, `src/image/decode.test.ts`

**Interfaces:**
- Consumes: 无（纯几何/工具函数部分可测；像素部分依赖浏览器 API）
- Produces:
  - `MAX_DIMENSION = 2048`
  - `align32(n: number): number` — 取最近的 32 的倍数，并钳到 `[512, 4096]`
  - `fitWithin(w: number, h: number, max: number): { width: number; height: number }` — 等比缩放到长边不超过 max
  - `type DecodedImage = { bitmap: ImageBitmap; width: number; height: number }`
  - `decodeImageFile(file: File): Promise<DecodedImage>` — 浏览器端解码，自动做 P3→sRGB

- [ ] **Step 1: 写失败测试 `src/image/decode.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { align32, fitWithin, MAX_DIMENSION } from './decode'

describe('fitWithin', () => {
  it('长边超过上限时等比缩小', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
  })

  it('已经在范围内就不放大', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })

  it('竖图按高度缩', () => {
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('正方形', () => {
    expect(fitWithin(4096, 4096, 2048)).toEqual({ width: 2048, height: 2048 })
  })
})

describe('align32', () => {
  it('已经是 32 的倍数就不动', () => {
    expect(align32(1024)).toBe(1024)
  })

  it('不是 32 的倍数就取最近的', () => {
    expect(align32(1200)).toBe(1216)   // 1200/32=37.5 -> 38*32
    expect(align32(1000)).toBe(992)    // 1000/32=31.25 -> 31*32
  })

  it('低于 512 时抬到 512', () => {
    expect(align32(300)).toBe(512)
  })

  it('高于 4096 时压到 4096', () => {
    expect(align32(9000)).toBe(4096)
  })

  it('结果一定是 32 的倍数', () => {
    for (const n of [1, 300, 511, 513, 1000, 1200, 2047, 4095, 9999]) {
      expect(align32(n) % 32).toBe(0)
    }
  })
})

describe('MAX_DIMENSION', () => {
  it('是 2048（spec §4.4）', () => {
    expect(MAX_DIMENSION).toBe(2048)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/image/decode.test.ts
```

预期：FAIL，`Failed to resolve import "./decode"`。

- [ ] **Step 3: 写实现 `src/image/decode.ts`**

```ts
/** 送给模型的图长边上限（spec §4.4）。调色路径不受此限制。 */
export const MAX_DIMENSION = 2048

/** API 硬约束：宽高必须是 32 的倍数，且在 [512, 4096]（spec §4.3） */
export const SIZE_MIN = 512
export const SIZE_MAX = 4096
const SIZE_STEP = 32

export function align32(n: number): number {
  const rounded = Math.round(n / SIZE_STEP) * SIZE_STEP
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, rounded))
}

export type Size = { width: number; height: number }

/** 等比缩放到长边不超过 max。只缩不放。 */
export function fitWithin(w: number, h: number, max: number): Size {
  const longest = Math.max(w, h)
  if (longest <= max) return { width: w, height: h }
  const k = max / longest
  return { width: Math.round(w * k), height: Math.round(h * k) }
}

export type DecodedImage = {
  /** 调用方负责在不再使用时调用 bitmap.close()——它占用的是 GPU 内存 */
  bitmap: ImageBitmap
  width: number
  height: number
}

/**
 * 解码用户选的文件。
 *
 * 关键：iPhone 拍的照片是 Display P3 色域，直接当 sRGB 用会让红色发暗、
 * 绿色发艳。这里用 createImageBitmap 的 colorSpaceConversion 让浏览器
 * 完成 P3 -> sRGB 转换（spec §5.3）。
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const raw = await createImageBitmap(file, {
    colorSpaceConversion: 'default',   // 让浏览器做色彩空间转换
    premultiplyAlpha: 'none',
  })
  try {
    const bitmap = await toSrgbBitmap(raw)
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } finally {
    // 必须是 finally：toSrgbBitmap 抛错时也得释放。
    // ImageBitmap 占的是 GPU 内存，泄漏几次就能把标签页拖垮。
    raw.close()
  }
}

/**
 * 把任意色域的位图重绘到 sRGB 画布上，再取回位图。
 *
 * 转换发生在 drawImage 那一行：2D 画布会按画布自身的色彩空间
 * （这里显式指定 srgb）解释源图并写入。若源图本来已是 sRGB，
 * 这一步就是恒等转换——所以**不会转换两次**。
 *
 * 早期版本在这里还调过一次 getImageData + putImageData，是多余的：
 * 它只是把同一批字节读出来再原样写回，却要多分配一个全分辨率的
 * 缓冲区（1200 万像素的照片约 49 MB）并强制一次 GPU 回读。
 */
async function toSrgbBitmap(src: ImageBitmap): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = src.width
  canvas.height = src.height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，无法做色彩空间转换')
  ctx.drawImage(src, 0, 0)   // ← 色彩空间转换就发生在这一行
  return createImageBitmap(canvas)
}

/**
 * 说明：`align32` 与 `fitWithin` 在本计划里暂时没有调用方——它们服务的是
 * 生成式编辑那条路（spec §4.4），属于计划二。放在这里是因为它们是
 * spec §4.3 / §4.4 那几条硬约束的可执行形式（32 的倍数、[512,4096]、长边 2048），
 * 用测试钉死比写在注释里可靠——那几条约束是真金白银试出来的。
 */
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx vitest run src/image/decode.test.ts
```

预期：PASS。`decodeImageFile` / `prepareForModel` 依赖浏览器 API，测试环境是 node，所以只测纯函数部分——这两个函数在 Task 7 的浏览器验收里手工验证。

- [ ] **Step 5: Commit**

```bash
git add src/image/decode.ts src/image/decode.test.ts
git commit -m "feat(image): 解码、P3→sRGB 转换、尺寸对齐到 32 倍数"
```

---

### Task 6: WebGL2 渲染管线

**Files:**
- Create: `src/render/shader.ts`, `src/render/pipeline.ts`

**Interfaces:**
- Consumes: `Unit`（Task 3）、`DecodedImage`（Task 5）
- Produces:
  - `class TonePipeline`
    - `constructor(canvas: HTMLCanvasElement)`
    - `setImage(img: DecodedImage): void`
    - `render(u: Unit): void`
    - `resizeToImage(): void` — 把 canvas 尺寸设成图片尺寸
    - `readPixels(): Uint8Array` — 仅测试用
    - `dispose(): void`

- [ ] **Step 1: 写 GLSL `src/render/shader.ts`**

```ts
/**
 * 八参数调色，单个 fragment shader 一次算完（spec §5.2）。
 *
 * 调色链的顺序必须与 src/core/tone.ts 的 applyTone 严格一致——两者共有
 * 六个参数：色温 / 曝光 / 高光 / 阴影 / 对比度 / 饱和度。
 *
 * 清晰度和暗角**只有本文件有**：它们分别需要邻域像素和像素坐标，
 * tone.ts 的单像素函数表达不了，没有可对照的实现。
 *
 * 改任何一边都必须同步改另一边。**本渲染器没有自动化测试**——
 * WebGL 要真实 GPU，写死像素的测试会很脆；正确性靠 Task 7 的浏览器验收。
 */
export const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // V 轴必须翻转。
  // texImage2D 把图像的第一行（顶行）放在 t=0，而 gl_Position.y = -1
  // 是屏幕底部——不翻的话画面上下颠倒。
  //
  // 注意：源是 ImageBitmap 时 UNPACK_FLIP_Y_WEBGL 会被 WebGL 忽略
  // （规范如此；ImageBitmap 的方向由创建时的 imageOrientation 决定），
  // 所以那个开关修不了这件事，只能在着色器里翻。
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform vec2  uTexel;       // 1.0 / 纹理尺寸
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uSaturation;
uniform float uTemperature;
uniform float uClarity;
uniform float uVignette;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// 注意 max(..., 0.0) 这两处不是多余的：
//   mix(x, y, a) 的语义是 x*(1-a) + y*a —— 两个分支**都会被求值**，
//   而 GLSL 规定 pow 的底数为负时结果未定义（实际会出 NaN），
//   NaN * 0 仍是 NaN，所以哪怕该分支最终会被丢弃，也会把 NaN 带进结果。
//
//   底数确实可能为负：温度 +100 时蓝通道减 0.1（暗部即负），
//   或清晰度在高反差边缘欠冲（base=0.1 / blur=0.5 → -0.14）。
//
//   tone.ts 用的是三元运算符，负值根本不进 pow，所以那边没这个问题——
//   这是 TS 与 GLSL 的真实行为分歧，不是精度差异。
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92,
             pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)),
             step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92,
             1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  // 0. 清晰度 —— 必须放在整条调色链的最前面，作用在原始纹理上。
  //
  //    放在后面是错的：那时 c 已经过曝光/对比度等处理，而 blur 采的还是
  //    原始像素，(c - blur) 里就混进一个全局亮度差，拖清晰度会顺带把
  //    整张图弄亮或弄暗。放在最前面时，平坦区域的 c - blur 恒为 0，
  //    清晰度就只影响局部细节。
  vec3 base = texture(uImage, uv).rgb;
  vec3 blur = (
      texture(uImage, uv + vec2(-uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2( uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2(0.0, -uTexel.y)).rgb
    + texture(uImage, uv + vec2(0.0,  uTexel.y)).rgb
  ) * 0.25;
  vec3 c = base + uClarity * 0.6 * (base - blur);

  // 1. 色温
  c.r += uTemperature * 0.10;
  c.b -= uTemperature * 0.10;

  // 2. 曝光（线性空间）
  c = srgbToLinear(c);
  c *= pow(2.0, uExposure);
  c = linearToSrgb(c);

  // 3. 高光 / 阴影
  float l = dot(c, LUMA);
  float hiW = smoothstep(0.5, 1.0, l) * 0.35 * uHighlights;
  float loW = (1.0 - smoothstep(0.0, 0.5, l)) * 0.35 * uShadows;
  c += vec3(hiW + loW);

  // 4. 对比度（中灰支点）
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // 5. 饱和度
  float l2 = dot(c, LUMA);
  c = vec3(l2) + (c - vec3(l2)) * (1.0 + uSaturation);

  // 6. 暗角
  //
  //    只钳下界（max），不钳上界。负的 uVignette 会让 vig > 1——
  //    那是「提亮四角」。若在这里钳到 1，滑块的负半程就完全没反应
  //    （滑块范围是 -100~100，负半程却是死的，用户会以为坏了）。
  //    溢出由最后那句 clamp(c, 0.0, 1.0) 兜住。
  vec2 d = uv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 3.5;
  c *= max(vig, 0.0);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`
```

- [ ] **Step 2: 写渲染器 `src/render/pipeline.ts`**

```ts
import type { Unit } from '../core/tone'
import type { DecodedImage } from '../image/decode'
import { VERTEX_SRC, FRAGMENT_SRC } from './shader'

const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
] as const

type UniformName = typeof UNIFORM_NAMES[number]

export class TonePipeline {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private program: WebGLProgram
  private texture: WebGLTexture
  private vao: WebGLVertexArrayObject
  private buffer: WebGLBuffer
  private uniforms = new Map<UniformName, WebGLUniformLocation | null>()
  private uTexel: WebGLUniformLocation | null = null
  private imageW = 0
  private imageH = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,   // 导出时需要 readPixels
    })
    if (!gl) throw new Error('这个浏览器不支持 WebGL2')
    this.gl = gl

    this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC)

    const positions = new Float32Array([-1, -1, 3, -1, -1, 3])
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    this.vao = vao!
    // 存下来，dispose 时要删——不然每 new 一个 TonePipeline 就漏一个 buffer
    this.buffer = buf!

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.texture = tex!

    for (const n of UNIFORM_NAMES) {
      this.uniforms.set(n, gl.getUniformLocation(this.program, n))
    }
    this.uTexel = gl.getUniformLocation(this.program, 'uTexel')
    gl.useProgram(this.program)
    gl.uniform1i(gl.getUniformLocation(this.program, 'uImage'), 0)
  }

  setImage(img: DecodedImage): void {
    const gl = this.gl
    this.imageW = img.width
    this.imageH = img.height
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // 这里不用（也设不了）UNPACK_FLIP_Y_WEBGL：源是 ImageBitmap 时
    // WebGL 会忽略该开关，上下方向由顶点着色器翻转 V 轴处理。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.bitmap)
  }

  resizeToImage(): void {
    this.canvas.width = this.imageW
    this.canvas.height = this.imageH
  }

  render(u: Unit): void {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)

    gl.uniform2f(this.uTexel, 1 / this.imageW, 1 / this.imageH)
    const map: Record<UniformName, number> = {
      uExposure: u.exposure,
      uContrast: u.contrast,
      uHighlights: u.highlights,
      uShadows: u.shadows,
      uSaturation: u.saturation,
      uTemperature: u.temperature,
      uClarity: u.clarity,
      uVignette: u.vignette,
    }
    for (const n of UNIFORM_NAMES) {
      gl.uniform1f(this.uniforms.get(n) ?? null, map[n])
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * 仅测试用：读回画布像素（RGBA, 8bit）。
   *
   * 行序遵循 GL 约定——**自下而上**，与图片文件的自上而下相反。
   * 直接把这批字节当图片编码会上下颠倒，用之前要先翻行。
   */
  readPixels(): Uint8Array {
    const gl = this.gl
    const w = this.canvas.width
    const h = this.canvas.height
    const out = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return out
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteTexture(this.texture)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.buffer)
  }
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const p = gl.createProgram()
  if (!p) throw new Error('创建着色器程序失败')
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('链接着色器失败: ' + gl.getProgramInfoLog(p))
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return p
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('创建着色器失败')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('编译着色器失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}
```

- [ ] **Step 3: 手工验证——把占位 App 换成最小渲染测试**

临时把 `src/App.tsx` 改成下面这样，跑起来用眼睛确认八参数真的生效：

```tsx
import { useEffect, useRef } from 'react'
import { TonePipeline } from './render/pipeline'
import { ZERO, toUnit } from './core/adjustments'

export default function App() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const pipe = new TonePipeline(canvas)
    // 造一张测试图。上半/下半颜色不同、左上角有白方块——
    // 这样"上下颠倒"或"左右镜像"是**看得出来**的。
    // （早先的版本左右分色、上下对称，恰好掩盖了 V 轴翻转的 bug。）
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#808080'                    // 上半：中灰
    ctx.fillRect(0, 0, 256, 128)
    ctx.fillStyle = '#cc6633'                    // 下半：橙
    ctx.fillRect(0, 128, 256, 128)
    ctx.fillStyle = '#ffffff'                    // 左上角白方块
    ctx.fillRect(0, 0, 56, 56)
    createImageBitmap(c).then(bm => {
      pipe.setImage({ bitmap: bm, width: 256, height: 256 })
      pipe.resizeToImage()
      pipe.render(toUnit({ ...ZERO, exposure: 40, saturation: 50, temperature: 30 }))
    })
    return () => pipe.dispose()
  }, [])
  return <canvas ref={ref} style={{ maxWidth: '90vw', maxHeight: '90vh' }} />
}
```

```bash
npm run dev
```

预期：看到左边灰块被提亮、右边橙块更暖更艳。**若报"编译着色器失败"，说明 GLSL 有语法错误，控制台会给出具体行号。**

- [ ] **Step 4: 关于测试**

这个任务**没有自动化测试，这是刻意的。**

WebGL 渲染需要真实的 GPU 上下文，node 测试环境跑不了；而且不同 GPU 的浮点精度有差异，把像素值写死会让测试变脆。

**着色器的正确性靠两层保证：**

1. 它的运算顺序必须与 `src/core/tone.ts` 的 `applyTone` 严格一致——**六个位置无关的参数**：色温、曝光、高光、阴影、对比度、饱和度（清晰度和暗角只有着色器有，因为需要邻域和坐标）
2. **Task 7 的浏览器验收**用眼睛确认每个参数都真的生效、方向对、幅度合理

**不要为了"有测试"而补一个断言不了任何东西的空测试**——那比没有测试更糟，它会让人以为这块被覆盖了。

- [ ] **Step 5: Commit**

```bash
git add src/render src/App.tsx
git commit -m "feat(render): WebGL2 八参数渲染管线"
```

---

### Task 7: 完整 UI 闭环（上传 → 滑块 → 实时预览 → 导出）

**Files:**
- Create: `src/ui/Uploader.tsx`, `src/ui/Canvas.tsx`, `src/ui/AdjustmentPanel.tsx`
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `TonePipeline`（Task 6）、`decodeImageFile`（Task 5）、`Adjustments` / `ZERO` / `toUnit`（Task 2）、`PRESETS`（Task 4）
- Produces: 一个能用的调色页面

- [ ] **Step 1: 写 `src/ui/Uploader.tsx`**

```tsx
type Props = { onPick: (file: File) => void }

export default function Uploader({ onPick }: Props) {
  return (
    <label className="uploader">
      <input
        type="file"
        accept="image/*"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
        }}
      />
      <span>选一张照片</span>
    </label>
  )
}
```

- [ ] **Step 2: 写 `src/ui/Canvas.tsx`**

```tsx
import { useEffect, useRef, type MutableRefObject } from 'react'
import { TonePipeline } from '../render/pipeline'
import type { DecodedImage } from '../image/decode'
import type { Unit } from '../core/tone'

type Props = {
  image: DecodedImage | null
  unit: Unit
  /** App 需要拿到 canvas 元素来做导出 */
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
}

/** 画布只负责"把渲染结果贴出来"，不碰像素、不碰状态。 */
export default function Canvas({ image, unit, canvasRef }: Props) {
  // 泛型必须写 <HTMLCanvasElement | null>。
  // 写成 <HTMLCanvasElement> 得到的是 Readonly 的 RefObject，
  // 下面 ref 回调里 innerRef.current = node 会报 TS2540。
  const innerRef = useRef<HTMLCanvasElement | null>(null)
  const pipeRef = useRef<TonePipeline | null>(null)

  useEffect(() => {
    const canvas = innerRef.current
    if (!canvas) return
    try {
      const pipe = new TonePipeline(canvas)
      pipeRef.current = pipe
      return () => {
        pipe.dispose()
        pipeRef.current = null
      }
    } catch (e) {
      console.error(e)
      alert('这个浏览器打不开 WebGL2，换 Chrome 或 Safari 试试')
    }
  }, [])

  // ① 图片换了才上传纹理、重设画布尺寸。
  //    这两件事都很贵——上传一次 1200 万像素的纹理、重设画布尺寸会清空
  //    并重新分配绘图缓冲。**绝不能跟着滑块走。**
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.setImage(image)
    pipe.resizeToImage()
  }, [image])

  // ② 换图后、以及拖滑块时，都只更新 uniform 重绘一次。
  //    不碰纹理、不碰画布尺寸（spec §5.2：拖滑块只更新 uniform → 60fps）。
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.render(unit)
  }, [image, unit])

  return <canvas ref={node => {
    innerRef.current = node
    canvasRef.current = node
  }} className="canvas" />
}
```

- [ ] **Step 3: 写 `src/ui/AdjustmentPanel.tsx`**

```tsx
import { PARAM_KEYS, type Adjustments, PARAM_MIN, PARAM_MAX } from '../core/adjustments'
import { PRESETS } from '../core/presets'

const LABELS: Record<keyof Adjustments, string> = {
  exposure: '曝光',
  contrast: '对比度',
  highlights: '高光',
  shadows: '阴影',
  saturation: '饱和度',
  temperature: '色温',
  clarity: '清晰度',
  vignette: '暗角',
}

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
  onReset: () => void
}

export default function AdjustmentPanel({ value, onChange, onReset }: Props) {
  const set = (k: keyof Adjustments, v: number) => onChange({ ...value, [k]: v })

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>微调</span>
        <button onClick={onReset}>重置</button>
      </div>

      <div className="presets">
        {PRESETS.map(p => (
          <button key={p.id} onClick={() => onChange({ ...p.adjustments })}>
            {p.label}
          </button>
        ))}
      </div>

      {PARAM_KEYS.map(k => (
        <label key={k} className="slider">
          <span className="slider-label">{LABELS[k]}</span>
          <input
            type="range"
            min={PARAM_MIN}
            max={PARAM_MAX}
            step={1}
            value={value[k]}
            onChange={e => set(k, Number(e.target.value))}
          />
          <span className="slider-value">{value[k]}</span>
        </label>
      ))}
    </aside>
  )
}
```

- [ ] **Step 4: 写 `src/App.tsx`（替换 Task 6 的临时版本）**

```tsx
import { useCallback, useMemo, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { ZERO, toUnit, type Adjustments } from './core/adjustments'

export default function App() {
  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  const [showPanel, setShowPanel] = useState(false)
  const [busy, setBusy] = useState(false)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const originalFileRef = useRef<File | null>(null)
  const imageRef = useRef<DecodedImage | null>(null)

  const unit = useMemo(() => toUnit(params), [params])

  const onPick = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const img = await decodeImageFile(file)
      // 先释放上一张：ImageBitmap 占的是 GPU 内存，不关会一直攒着
      imageRef.current?.bitmap.close()
      imageRef.current = img
      originalFileRef.current = file
      setImage(img)
      setParams(ZERO)
    } catch (e) {
      console.error(e)
      alert('这张图打不开，换一张试试')
    } finally {
      setBusy(false)
    }
  }, [])

  // 导出：画布尺寸就是原图尺寸——调色不缩图（spec §4.4）
  const onSave = useCallback(() => {
    const canvas = canvasElRef.current
    if (!canvas) return
    canvas.toBlob(b => {
      if (!b) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(b)
      a.download = 'ruixing.png'
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/png')
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">RuiXing</span>
        {image && (
          <div className="actions">
            <button onClick={() => setShowPanel(v => !v)}>微调</button>
            <button className="primary" onClick={onSave}>保存</button>
          </div>
        )}
      </header>

      <main className="stage">
        {!image && !busy && <Uploader onPick={onPick} />}
        {busy && <div className="hint">正在打开照片…</div>}
        {image && (
          <div className="workspace">
            <Canvas image={image} unit={unit} canvasRef={canvasElRef} />
          </div>
        )}
      </main>

      {image && showPanel && (
        <AdjustmentPanel
          value={params}
          onChange={setParams}
          onReset={() => setParams(ZERO)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 5: 补 `src/styles.css`**

在文件末尾追加：

```css
.app { min-height: 100vh; display: flex; flex-direction: column; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; border-bottom: 1px solid #2a2e35;
}
.brand { font-weight: 600; letter-spacing: .05em; }
.actions { display: flex; gap: 8px; }

button {
  background: var(--panel); color: var(--text); border: 1px solid #2f343c;
  border-radius: 8px; padding: 6px 14px; cursor: pointer; font: inherit;
}
button:hover { border-color: #4a515b; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

.stage { flex: 1; display: flex; align-items: center; justify-content: center; padding: 20px; }

.workspace { max-width: 100%; max-height: 100%; display: flex; }
.canvas { max-width: 100%; max-height: 78vh; object-fit: contain; border-radius: 8px; }

.uploader {
  border: 2px dashed #3a4048; border-radius: 14px; padding: 60px 80px;
  cursor: pointer; color: var(--muted);
}
.uploader input { display: none; }
.uploader:hover { border-color: var(--accent); color: var(--text); }

.hint { color: var(--muted); }

.panel {
  border-top: 1px solid #2a2e35; background: var(--panel);
  padding: 14px 20px; max-height: 42vh; overflow-y: auto;
}
.panel-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 10px; color: var(--muted);
}
.presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }

.slider {
  display: grid; grid-template-columns: 64px 1fr 44px;
  align-items: center; gap: 12px; margin: 6px 0;
}
.slider-label { color: var(--muted); font-size: 13px; }
.slider-value { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
.slider input { width: 100%; }
```

- [ ] **Step 6: 浏览器验收（手工，这是本任务的核心验收）**

```bash
npm run dev
```

逐条确认：

1. 打开页面 → 看到虚线框「选一张照片」
2. 选一张手机拍的竖图 → 显示出来，**没有变形、没有偏色**（偏色说明 P3→sRGB 有问题）
3. 点「微调」→ 面板展开，八个滑块 + 六个预设
4. **拖动曝光滑块 → 画面实时跟着变，没有卡顿感**（这是整个产品的手感底线）
5. 点「日系通透」→ 画面立刻变成那套参数的样子，滑块位置也同步跳过去了
6. 点「重置」→ 回到原图
7. 点「保存」→ 下载一张 PNG，**用看图软件打开，确认是全分辨率、不是缩过的**
8. 拿一张**横图**再走一遍 2~7

- [ ] **Step 7: 跑全部测试**

```bash
npm test
```

预期：全部 PASS（core 三个文件 + image 一个文件），render 那个在 node 下跳过。

- [ ] **Step 8: Commit**

```bash
git add src
git commit -m "feat(ui): 上传、实时预览、八滑块与预设面板、导出"
```

---

## 中途发现的缺口

核对 spec 覆盖情况时发现：**§5.4「保留 EXIF」没有对应任务。**

原因是浏览器端 `canvas.toBlob()` 产出的图**天然不带原始 EXIF**——要保留必须手动解析原文件的 EXIF 再写回去，需要引入一个 EXIF 库。这是一块独立的工作，所以单独补成 Task 8。

---

### Task 8: 导出时保留 EXIF

**Files:**
- Create: `src/export/save.ts`, `src/export/save.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `exportImage(canvas: HTMLCanvasElement, originalFile: File, format?: 'image/jpeg' | 'image/png'): Promise<void>`

- [ ] **Step 1: 装 EXIF 库**

```bash
npm install piexifjs
npm install -D @types/piexifjs
```

**如果 `@types/piexifjs` 装不上**（它可能不在 npm 上），改用本地声明：新建 `src/types/piexif.d.ts`：

```ts
declare module 'piexifjs' {
  type ExifDict = {
    '0th': Record<number, unknown>
    Exif: Record<number, unknown>
    GPS: Record<number, unknown>
    Interop: Record<number, unknown>
    '1st': Record<number, unknown>
    thumbnail: string | null
  }
  const piexif: {
    load(dataUrl: string): ExifDict
    dump(exifObj: ExifDict): string
    insert(exifBytes: string, dataUrl: string): string
    ImageIFD: Record<string, number>
    ExifIFD: Record<string, number>
  }
  export default piexif
}
```

并在 `tsconfig.json` 的 `include` 里确认 `src` 已覆盖（本来就是 `["src"]`，无需改动）。

- [ ] **Step 2: 写失败测试 `src/export/save.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { buildFilename } from './save'

describe('buildFilename', () => {
  it('在原文件名后加 _ruixing 后缀', () => {
    expect(buildFilename('IMG_1234.JPG', 'image/jpeg')).toBe('IMG_1234_ruixing.jpg')
  })

  it('PNG 用 .png 后缀', () => {
    expect(buildFilename('photo.png', 'image/png')).toBe('photo_ruixing.png')
  })

  it('没有扩展名也能处理', () => {
    expect(buildFilename('weird', 'image/jpeg')).toBe('weird_ruixing.jpg')
  })

  it('多个点只替换最后一段扩展名', () => {
    expect(buildFilename('a.b.c.jpeg', 'image/jpeg')).toBe('a.b.c_ruixing.jpg')
  })
})
```

- [ ] **Step 3: 跑测试，确认失败**

```bash
npx vitest run src/export/save.test.ts
```

预期：FAIL，`Failed to resolve import "./save"`。

- [ ] **Step 4: 写实现 `src/export/save.ts`**

```ts
import piexif from 'piexifjs'

export type ExportFormat = 'image/jpeg' | 'image/png'

export function buildFilename(original: string, format: ExportFormat): string {
  const ext = format === 'image/png' ? 'png' : 'jpg'
  const stem = original.replace(/\.[^.]+$/, '')
  return `${stem}_ruixing.${ext}`
}

/**
 * 导出画布内容为文件下载。JPEG 时把原图的 EXIF 写回去（spec §5.4）。
 *
 * 为什么要写回 EXIF：canvas.toBlob() 产出的图不带原始 EXIF，
 * 拍摄时间和 GPS 会丢，而旅游照的时间地点对用户有意义。
 */
export async function exportImage(
  canvas: HTMLCanvasElement,
  originalFile: File,
  format: ExportFormat = 'image/jpeg',
  quality = 0.95,
): Promise<void> {
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, format, quality))
  if (!blob) throw new Error('导出失败：canvas 没有产出图片')

  let payload: Blob = blob

  if (format === 'image/jpeg') {
    try {
      payload = await withExif(blob, originalFile)
    } catch (e) {
      // EXIF 写回失败不该挡住用户拿到图，降级为不带 EXIF 保存
      console.warn('EXIF 写回失败，照常导出（无 EXIF）', e)
    }
  }

  const url = URL.createObjectURL(payload)
  const a = document.createElement('a')
  a.href = url
  a.download = buildFilename(originalFile.name, format)
  a.click()
  URL.revokeObjectURL(url)
}

async function withExif(blob: Blob, originalFile: File): Promise<Blob> {
  const originalDataUrl = await fileToDataUrl(originalFile)
  const exifObj = piexif.load(originalDataUrl)

  // 尺寸会变，这四个字段必须清掉，否则看图软件会显示错误信息
  delete exifObj['0th']?.[piexif.ImageIFD.ImageWidth]
  delete exifObj['0th']?.[piexif.ImageIFD.ImageLength]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelXDimension]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelYDimension]

  // Orientation 也必须清掉，这条最容易漏。
  //
  // 解码时 createImageBitmap 的 imageOrientation 默认是 'from-image'，
  // 意思是**已经按 EXIF 把画面摆正了**——canvas 上是正立的像素网格。
  // 若再把原始的 Orientation=6（含义是"显示时顺时针转 90°"）写回去，
  // 看图软件会对着已经正立的图**再转一次**，导出图的方向就错了。
  //
  // 竖拍的手机照片几乎全都带 Orientation=6，所以这条不处理必然翻车。
  delete exifObj['0th']?.[piexif.ImageIFD.Orientation]

  const exifBytes = piexif.dump(exifObj)
  const newDataUrl = await blobToDataUrl(blob)
  return dataUrlToBlob(piexif.insert(exifBytes, newDataUrl))
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
npx vitest run src/export/save.test.ts
```

预期：PASS。

- [ ] **Step 6: 改 `src/App.tsx` 用新导出函数**

把 `onSave` 整个替换成：

```tsx
  const [saving, setSaving] = useState(false)

  const onSave = useCallback(async () => {
    const canvas = canvasElRef.current
    const file = originalFileRef.current
    if (!canvas || !file) return
    setSaving(true)
    try {
      await exportImage(canvas, file, 'image/jpeg', 0.95)
    } catch (e) {
      console.error(e)
      alert('保存失败，再试一次')
    } finally {
      setSaving(false)
    }
  }, [])
```

（`canvasElRef` 和 `originalFileRef` 在 Task 7 里已经建好了，直接用，不用新增。）

在文件顶部加一行导入：

```tsx
import { exportImage } from './export/save'
```

「保存」按钮加上 loading 态：

```tsx
<button className="primary" onClick={onSave} disabled={saving}>
  {saving ? '保存中…' : '保存'}
</button>
```

- [ ] **Step 7: 浏览器验收**

```bash
npm run dev
```

1. 选一张**有拍摄时间和 GPS 的手机照片**（在相册里能看到"拍摄于某地"的那种）
2. 调一下色，点「保存」
3. 下载的 `xxx_ruixing.jpg` 用系统看图工具打开属性，**确认拍摄时间还在**

- [ ] **Step 8: 跑全部测试**

```bash
npm test
```

预期：全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add src package.json package-lock.json
git commit -m "feat(export): 导出时保留原始 EXIF"
```

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 章节 | 对应任务 |
|---|---|
| §5.1 八个参数 | Task 2 |
| §5.1 一键风格预设 | Task 4 |
| §5.2 单 pass 渲染 | Task 6 |
| §5.3 色彩管理 P3→sRGB | Task 5 |
| §5.4 保留 EXIF | **Task 8** |
| §4.4 调色不缩图 | Task 7 |
| §3.4 参数范围与类型 | Task 2 |
| §7.3 最早验证调色质量 | 整个计划 |

**占位符扫描**：无 TBD / TODO / "稍后补充"。每个代码步骤都有完整代码。

**类型一致性检查**：
- `Adjustments` 字段名在 Task 2、3、4、6、7 中一致（`exposure`/`contrast`/`highlights`/`shadows`/`saturation`/`temperature`/`clarity`/`vignette`）
- `Unit` 类型在 Task 3 定义、Task 6 消费，名字一致
- `DecodedImage` 在 Task 5 定义、Task 6/7 消费，字段 `bitmap`/`width`/`height` 一致
- `TonePipeline` 方法名 `setImage`/`render`/`resizeToImage`/`dispose` 在 Task 6 定义、Task 7 消费，一致
- `PARAM_MIN`/`PARAM_MAX` 在 Task 2 定义、Task 7 消费，一致
- `MAX_DIMENSION` 在 Task 5 定义并测试

**已知的取舍**：
- **Task 6 没有自动化测试**，正确性靠 Task 7 的浏览器验收。理由：WebGL 要真实 GPU，不同 GPU 浮点精度有差异，写死像素的测试会很脆。用一个断言不了任何东西的空测试凑数，比没有测试更糟——它会让人误以为这块被覆盖了。
- **`tone.ts` 与 `shader.ts` 有两份相同数学，是刻意的重复。** 着色器无法单元测试，但调色数学不测就是赌。`tone.ts` 是可测的参考实现（测试的标准答案），`shader.ts` 是它的高性能移植。代价：调参时要同时改两处，靠两边文件顶部的注释互指来防漂移。
- Task 5 的 `align32` / `fitWithin` 在本计划里没有调用方，是给计划二预留的 spec 约束编码（该任务里已注明理由）。
