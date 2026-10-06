# 调色屏工具行（第一批：裁剪 / 对比）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「调色」屏照片上方立起一条**工具行**，先落两个工具：**裁剪·旋转·水平矫正** 和 **对比（分屏）**。

**Architecture:** 工具行是一条和【修图】屏历史转盘同款的横带子（`.strip` 那套长相），点开一个工具就在下面长出第二行控件。两个工具都**纯本地**：裁剪把几何变换作用在**底图 `base`** 上、`params`/`lut` 原样带过去，产出**新的一步**（走既有的 history 通道，能回到上一步、能落盘）；对比是在 `.canvas-clip` 里叠一张原图、用 `clip-path` 切一半 + 一条能拖的把手。

**Tech Stack:** React 18 · TypeScript · 现有 WebGL 管线和 history/快照模型 · vitest（jsdom）· Playwright 探针（真机）。

**Spec:** `docs/superpowers/specs/2026-10-06-edit-tools-design.md`（**执行前先通读**）

## Global Constraints

- **裁剪作用在 `base` 上，`params` / `lut` 原样跟着走** —— 用户调好的滑块一个都不许丢（spec §3.1）。
- **本地步骤没有 `prompt`**（`undefined`，**不许写空串**）→ 不出「再来一版」（spec §4）。
- **本地步骤就是普通的一步**：能回到这一步、能删、能落盘（spec §4）。
- **进任何一个工具先把视图收回「适应窗口」**，工具开着时**手势和右下角那排缩放按钮停用**（spec §3.1/§3.0）。
- **对比比的是"原图"**（和「按住看原图」同一个原图），**不是上一步**（spec §3.3）。
- **工具行只在调色屏**（`view.kind === 'adjust'`）—— 修图屏那条带子是历史转盘，不许动（spec §2.3）。
- 这一批**不接任何云、不加载任何模型**（点修是第二批）。
- 提交前 `npm test` + `npm run typecheck` 两个都要绿；**改完跑一次 `npm run check:layout`**。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/ToolBar.tsx`（新） | 工具行本体：三个格子 + 第二行（放当前工具的控件）。**不认识任何具体工具**，只认 `active` 和 `onPick`。 |
| `src/ui/CropOverlay.tsx`（新） | 照片上那个裁剪框：暗罩 + 框 + 八个把手 + 拖拽。只认"归一化矩形 + 回调"。 |
| `src/ui/CompareSplit.tsx`（新） | 对比分屏：原图层（`clip-path`）+ 中间那条把手。 |
| `src/core/crop.ts`（新） | **纯函数**：旋转后的外框尺寸、最大内接矩形、归一化矩形的夹取、按比例档适配。没有 DOM。 |
| `src/image/crop.ts`（新） | 把上面那套算式落到一张 `ImageBitmap` 上：`cropToBitmap()`。 |
| `src/app/useLocalStep.ts`（新） | **本地新步骤**的唯一入口：推快照 + 换底图 + 挪光标 + 说一句话 + 切未来。裁剪用它，第二批的点修也用它。 |
| `src/ui/Canvas.tsx`（改） | 新增三个可选 prop：`viewLocked` / `crop` / `compareWith`。渲染裁剪框（在剪裁层**外面**）和对比层（在剪裁层**里面**）。 |
| `src/App.tsx`（改） | `tool` 状态、工具行的渲染位、裁剪的提交、对比的原图准备、给 Canvas 的新 prop。 |
| `src/styles.css`（改） | `.tool-row` / `.crop-*` / `.compare-*`。 |

---

### Task 1: 工具行的壳子（含"视图归位 + 手势停用"）

**Files:**
- Create: `src/ui/ToolBar.tsx`、`src/ui/ToolBar.test.tsx`
- Modify: `src/ui/Canvas.tsx`（加 `viewLocked`）、`src/App.tsx`（状态 + 渲染 + 把 key 传给 Canvas）、`src/styles.css`
- Test: `src/App.test.tsx`（加一条：工具行只在调色屏）

**Interfaces:**
- Produces:
  - `type ToolId = 'crop' | 'compare'`
  - `ToolBar({ active, onPick, children })`：`active: ToolId | null`、`onPick: (t: ToolId | null) => void`、`children` = 当前工具的第二行控件
  - `Canvas` 新 prop：`viewLocked?: boolean`（为真时：滚轮/拖动/双击全不响应，右下角那排按钮不渲染）

- [ ] **Step 1: 写失败的测试**（`src/ui/ToolBar.test.tsx`）

```tsx
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ToolBar from './ToolBar'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const pick = async (label: string) => {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
  await act(async () => { el.click() })
}

describe('工具行', () => {
  it('三个格子；点一下告诉上层，再点一下收回', async () => {
    const seen: (string | null)[] = []
    await act(async () => { root.render(<ToolBar active={null} onPick={t => seen.push(t)} />) })
    expect(container.querySelectorAll('.tool-cell')).toHaveLength(2)
    await pick('裁剪')
    await pick('对比')
    expect(seen).toEqual(['crop', 'compare'])
  })

  it('★ 开着工具时，第二行才出现；点当前工具是"收回"（传 null）', async () => {
    const seen: (string | null)[] = []
    const draw = (active: 'crop' | null) => act(async () => {
      root.render(<ToolBar active={active} onPick={t => seen.push(t)}>
        <span className="probe">第二行</span>
      </ToolBar>)
    })
    await draw(null)
    expect(container.querySelector('.probe')).toBeNull()      // 没开工具：第二行不在
    await draw('crop')
    expect(container.querySelector('.probe')).toBeTruthy()    // 开着：在
    await pick('裁剪')                                        // 再点一下当前那颗 = 收回
    expect(seen).toEqual([null])
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/ui/ToolBar.test.tsx --minWorkers=1 --maxWorkers=2`
Expected: FAIL —— 找不到 `./ToolBar`

- [ ] **Step 3: 写 `src/ui/ToolBar.tsx`**

```tsx
/**
 * 调色屏照片上方那条**工具行**（★ 2026-10-06）。
 * 长相和历史转盘那条带子（`.strip`）是同一套：`--raised` 实心底 + 一道 `--line`。
 * 它**不认识任何具体工具** —— 只把"谁开着"喊出去，第二行由调用方塞进 children。
 */
export type ToolId = 'crop' | 'compare'

const CELLS: { id: ToolId; name: string }[] = [
  { id: 'crop', name: '裁剪' },
  { id: 'compare', name: '对比' },
]

export default function ToolBar(props: {
  active: ToolId | null
  onPick: (t: ToolId | null) => void
  children?: React.ReactNode
}) {
  return (
    <div className="tool-row">
      <div className="tool-row-main">
        {CELLS.map(c => (
          <button
            key={c.id} type="button" aria-label={c.name}
            className={`tool-cell${props.active === c.id ? ' on' : ''}`}
            // 再点一下当前这颗 = 收回（和左栏那些格子的手感一致）
            onClick={() => props.onPick(props.active === c.id ? null : c.id)}
          >{c.name}</button>
        ))}
      </div>
      {props.active && <div className="tool-row-second">{props.children}</div>}
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run src/ui/ToolBar.test.tsx --minWorkers=1 --maxWorkers=2`
Expected: PASS（2 条）

- [ ] **Step 5: 给 `Canvas` 加 `viewLocked`**

在 `Canvas.tsx` 的 `Props` 里加（放在 `resetKey` 后面）：

```tsx
  /**
   * ★ 2026-10-06（工具行）：工具开着时**手势停用** —— 滚轮、拖动、双击都不响应，
   * 右下角那排缩放按钮也不画。
   * 理由：裁剪时一边拉框一边缩放会让框和手指打架（spec §3.1）。
   */
  viewLocked?: boolean
```

然后在三处加闸（**都要加 `!viewLocked &&`**，别的都不动）：
1. `onPointerDown` 第一句改成 `if (!image || viewLocked) return`
2. `onDoubleClick` 里 `if (!image || !wrap || picking) return` 改成 `if (!image || !wrap || picking || viewLocked) return`
3. 滚轮 effect：`if (!wrap || !image) return` 改成 `if (!wrap || !image || viewLocked) return`，**并把 `viewLocked` 加进那条 effect 的依赖数组**
4. 右下角那排按钮的 `{image && (` 改成 `{image && !viewLocked && (`

- [ ] **Step 6: App 接线（状态 + 渲染位 + key）**

在 `App.tsx` 顶部状态区加：

```tsx
  /** ★ 2026-10-06（工具行）：调色屏当前开着哪个工具。null = 都没开。 */
  const [tool, setTool] = useState<ToolId | null>(null)
```

在 `<Canvas … />` 那一处（调色屏和修图屏共用同一个 Canvas）加两个 prop：

```tsx
                  // ★ 2026-10-06（工具行）：进工具先把视图收回「适应窗口」——
                  //   和"换会话"走同一条路（`resetKey` 是 dep，值一变就归位）。
                  //   值必须**按值稳定**（字符串），别传对象/数组（每渲染一次都是新身份）。
                  resetKey={`${sessionId ?? ''}:${tool ?? ''}`}
                  viewLocked={tool !== null}
```

在调色屏的 `.stage` 里、照片那块**之前**渲染工具行（只有调色屏有）：

```tsx
              {view.kind === 'adjust' && (
                <ToolBar active={tool} onPick={setTool}>{/* Task 4 把裁剪的第二行塞这儿 */}</ToolBar>
              )}
```

并在文件顶部 import：`import ToolBar, { type ToolId } from './ui/ToolBar'`

⚠️ **切屏要收工具**：`view.kind` 一变就 `setTool(null)`——加一条 effect：

```tsx
  // ★ 工具行只在调色屏；切走时把工具收掉 —— 不然回到调色屏时它还开着，
  //   而那时候照片可能已经换了（裁剪框会落在新照片上）。
  useEffect(() => { setTool(null) }, [view.kind])
```

- [ ] **Step 7: 样式（`src/styles.css`）**

接在 `.strip` 那一节后面：

```css
/* ── 调色屏的工具行（★ 2026-10-06）────────────────────────────────────
   和上面那条历史转盘带子**同一套语言**（同一块地方，两个屏各用一次）：
   `--raised` 实心 + 一道 `--line`。第一行是三颗工具，第二行是当前工具的控件。 */
.tool-row {
  flex: none;
  background: var(--raised);
  border-bottom: 1px solid var(--line);
}
.tool-row-main { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.tool-row-second {
  display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
  padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line);
}
/* 真按钮 → 逐条按掉全局 `button{}` 那套方框（和 `.rail-tile` / `.lut-tile` 同一条老路） */
.tool-cell {
  padding: 5px 12px; background: none; border: 1px solid transparent;
  border-radius: var(--r-pill); color: var(--muted); font-size: 13px; cursor: pointer;
}
.tool-cell:hover { background: var(--hover); color: var(--text); }
.tool-cell.on { color: var(--accent-300); border-color: var(--accent); background: var(--accent-tint); }
```

- [ ] **Step 8: 加一条 App 测试（工具行只在调色屏）**

在 `src/App.test.tsx` 里加（跟着它现有的"切屏"用例写）：

```tsx
  it('★ 工具行只在调色屏；修图屏那条带子还是历史转盘', async () => {
    // …按本文件里既有的做法挂起 App、上传一张照片（见同文件其它用例的 setup）…
    // 修图屏：没有工具行
    expect(container.querySelector('.tool-row')).toBeNull()
    // 走左栏进调色屏（`goNav('adjust')` 那套）之后：
    expect(container.querySelector('.tool-row')).toBeTruthy()
  })
```

⚠️ 这段要**照抄同文件里最近一条"切到调色屏"的用例**的写法（挂载方式、上传方式、怎么切屏），别自创。

- [ ] **Step 9: 全量测试 + 类型**

Run: `npm test -- --minWorkers=1 --maxWorkers=2` → 全绿
Run: `npm run typecheck` → 干净

- [ ] **Step 10: 提交**

```bash
git add src/ui/ToolBar.tsx src/ui/ToolBar.test.tsx src/ui/Canvas.tsx src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(调色): 工具行的壳子 —— 照片上方那条带子 + 进工具时归位并停用手势"
```

---

### Task 2: 裁剪的几何（纯函数，先把算式钉死）

**Files:**
- Create: `src/core/crop.ts`、`src/core/crop.test.ts`

**Interfaces:**
- Produces:
  - `type CropRect = { x: number; y: number; w: number; h: number }`（**归一化 0~1**，相对「旋转后的外框」）
  - `type CropSpec = { rect: CropRect; angle: number }`（`angle` 单位度，**只装 −15~+15 的矫正角**）
  - `export const MAX_STRAIGHTEN = 15`
  - `rotatedBounds(w: number, h: number, angleDeg: number): { w: number; h: number }`
  - `inscribedRect(w: number, h: number, angleDeg: number): { w: number; h: number }`（**像素**，居中的最大内接矩形）
  - `fitAspect(r: {w:number;h:number}, aspect: number | null): {w:number;h:number}`
  - `rectFromSize(size: {w:number;h:number}, bounds: {w:number;h:number}): CropRect`（居中）
  - `clampRect(r: CropRect): CropRect`
  - `cropOutputSize(spec: CropSpec, turns: number, imgW: number, imgH: number): { width: number; height: number }`
  - `effectiveAngle(spec: CropSpec, turns: number): number`（`turns*90 + spec.angle`）

- [ ] **Step 1: 写失败的测试**（`src/core/crop.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_STRAIGHTEN, clampRect, cropOutputSize, effectiveAngle, fitAspect, inscribedRect,
  rectFromSize, rotatedBounds, type CropSpec,
} from './crop'

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('rotatedBounds —— 转过来之后占多大一块', () => {
  it('不转就是原来那块', () => {
    expect(rotatedBounds(1000, 500, 0)).toEqual({ w: 1000, h: 500 })
  })
  it('90 度：长宽对调（不会多出空白角）', () => {
    expect(rotatedBounds(1000, 500, 90)).toEqual({ w: 500, h: 1000 })
  })
  it('15 度：两头都长大', () => {
    const b = rotatedBounds(1000, 500, 15)
    expect(b.w).toBeGreaterThan(1000)
    expect(b.h).toBeGreaterThan(500)
  })
})

describe('inscribedRect —— 转完之后，不露空角的最大矩形', () => {
  it('★ 不转 = 整张（归一化就是 1×1）', () => {
    const b = rotatedBounds(1000, 500, 0)
    const r = inscribedRect(1000, 500, 0)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 90 度也是整张（转直角不会露角）', () => {
    const b = rotatedBounds(1000, 500, 90)
    const r = inscribedRect(1000, 500, 90)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 转 1 度就要缩一点；转 15 度缩得更多（单调）', () => {
    const a1 = inscribedRect(1000, 500, 1)
    const a15 = inscribedRect(1000, 500, 15)
    expect(a1.w).toBeLessThan(1000)
    expect(a15.w).toBeLessThan(a1.w)
  })
  it('★ 内接矩形不许超过原图（面积意义上：它就是"能留下的最大一块"）', () => {
    for (const deg of [1, 5, 15, -15, -7.5]) {
      const r = inscribedRect(1000, 500, deg)
      expect(r.w * r.h).toBeLessThanOrEqual(1000 * 500 + 1e-6)
      expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
    }
  })
})

describe('fitAspect / rectFromSize / clampRect', () => {
  it('给了比例档就按它收（装得下为前提）', () => {
    // 可用区 800×600，要 1:1 → 600×600
    expect(fitAspect({ w: 800, h: 600 }, 1)).toEqual({ w: 600, h: 600 })
    // 要 16:9 → 800×450
    expect(fitAspect({ w: 800, h: 600 }, 16 / 9)).toEqual({ w: 800, h: 450 })
  })
  it('自由档原样返回', () => {
    expect(fitAspect({ w: 800, h: 600 }, null)).toEqual({ w: 800, h: 600 })
  })
  it('居中的归一化矩形', () => {
    expect(rectFromSize({ w: 400, h: 300 }, { w: 800, h: 600 }))
      .toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })
  it('夹进 0~1；太小的框给一个下限（别让它缩成 0）', () => {
    expect(clampRect({ x: -1, y: 2, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const tiny = clampRect({ x: .5, y: .5, w: 0.0001, h: 0.0001 })
    expect(tiny.w).toBeCloseTo(0.02); expect(tiny.h).toBeCloseTo(0.02)
  })
})

describe('cropOutputSize —— 裁出来多少像素', () => {
  const spec = (rect: [number, number, number, number], angle = 0): CropSpec =>
    ({ rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, angle })
  it('不转、整张 → 就是原图尺寸', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 0, 1200, 800)).toEqual({ width: 1200, height: 800 })
  })
  it('裁一半 → 一半像素', () => {
    expect(cropOutputSize(spec([0, 0, .5, .5]), 0, 1200, 800)).toEqual({ width: 600, height: 400 })
  })
  it('★ 转 90 度 → 长宽对调', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 1, 1200, 800)).toEqual({ width: 800, height: 1200 })
  })
  it('★ 转完之后**不许放大**：像素总数不超过原图', () => {
    // 15 度时外框比原图大，内接矩形几乎占满外框 —— 不设上限就会输出比原图更大的图
    const r = inscribedRect(1200, 800, MAX_STRAIGHTEN)
    const b = rotatedBounds(1200, 800, MAX_STRAIGHTEN)
    const out = cropOutputSize({ rect: rectFromSize(r, b), angle: MAX_STRAIGHTEN }, 0, 1200, 800)
    expect(out.width * out.height).toBeLessThanOrEqual(1200 * 800 + 1)
    expect(out.width).toBeGreaterThan(0)
  })
  it('effectiveAngle 把 90 度整转和矫正角合起来', () => {
    expect(effectiveAngle(spec([0, 0, 1, 1], 7), 1)).toBe(97)
    expect(effectiveAngle(spec([0, 0, 1, 1], -7), 3)).toBe(263)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/core/crop.test.ts --minWorkers=1 --maxWorkers=2`
Expected: FAIL —— 找不到 `./crop`

- [ ] **Step 3: 写 `src/core/crop.ts`**

```ts
/**
 * 裁剪 / 旋转 / 水平矫正的**算式**（★ 2026-10-06）。纯函数，不碰 DOM。
 *
 * 坐标系只有一套，后面每处注释都按它说话：
 *   · **底图**：用户手上那张 `base`，`imgW × imgH`。
 *   · **外框（bounds）**：底图转 `θ` 之后占的那块**轴对齐**矩形
 *     （`rotatedBounds`）。转过的照片有四个空角，外框把它们也框进来。
 *   · **裁剪框**：`CropRect`，**相对外框**归一化的 0~1。
 *     ——为什么要拿"外框"当基准：照片在界面上转、框不转，
 *     所以框量出来的那条边就是外框那条边（`Canvas` 量到的盒子就是外框）。
 *
 * ⚠️ 一条硬规矩（v1）：**角度一变，框重置成"居中的最大内接矩形"** ——
 *    内接矩形按定义不碰空角，所以用户怎么拖都不会裁出空白角。
 *    代价是"转完再去抠一个角"这一版做不了，写在 spec 的已知边界里。
 */
export type CropRect = { x: number; y: number; w: number; h: number }
export type CropSpec = { rect: CropRect; angle: number }
export const MAX_STRAIGHTEN = 15
/** 框的最小边长（归一化）：别让它缩成一条线。 */
const MIN_SIDE = 0.02

const rad = (deg: number) => (deg * Math.PI) / 180

export function rotatedBounds(w: number, h: number, angleDeg: number): { w: number; h: number } {
  const c = Math.abs(Math.cos(rad(angleDeg)))
  const s = Math.abs(Math.sin(rad(angleDeg)))
  return { w: w * c + h * s, h: w * s + h * c }
}

/** 转 `angleDeg` 之后，**不碰空角**的最大轴对齐矩形（居中，单位像素）。 */
export function inscribedRect(w: number, h: number, angleDeg: number): { w: number; h: number } {
  const a = Math.abs(rad(angleDeg)) % Math.PI
  const side = a > Math.PI / 2 ? Math.PI - a : a
  const c = Math.abs(Math.cos(side))
  const s = Math.abs(Math.sin(side))
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const widthIsLonger = w >= h
  // 窄长条 + 大角度：内接矩形会退化成"贴住短边"的那一支（经典解的第一种情形）
  if (short <= 2 * s * c * long || Math.abs(s - c) < 1e-10) {
    const x = 0.5 * short
    return widthIsLonger ? { w: x / s, h: x / c } : { w: x / c, h: x / s }
  }
  const cos2 = c * c - s * s
  return widthIsLonger
    ? { w: (w * c - h * s) / cos2, h: (h * c - w * s) / cos2 }
    : { w: (h * c - w * s) / cos2, h: (w * c - h * s) / cos2 }
}

/** 按比例档收（装得下为前提）。`null` = 自由，原样返回。 */
export function fitAspect(r: { w: number; h: number }, aspect: number | null): { w: number; h: number } {
  if (aspect === null) return r
  let w = r.w
  let h = w / aspect
  if (h > r.h) { h = r.h; w = h * aspect }
  return { w, h }
}

/** 居中的归一化矩形。 */
export function rectFromSize(size: { w: number; h: number }, bounds: { w: number; h: number }): CropRect {
  const w = size.w / bounds.w
  const h = size.h / bounds.h
  return clampRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
}

export function clampRect(r: CropRect): CropRect {
  const w = Math.min(1, Math.max(MIN_SIDE, r.w))
  const h = Math.min(1, Math.max(MIN_SIDE, r.h))
  const x = Math.min(1 - w, Math.max(0, r.x))
  const y = Math.min(1 - h, Math.max(0, r.y))
  return { x, y, w, h }
}

export function effectiveAngle(spec: CropSpec, turns: number): number {
  return turns * 90 + spec.angle
}

/**
 * 裁出来是多少像素。
 * ⚠️ **最后要扣一顶"不许放大"的帽子**：转 15 度时外框比原图大，框又几乎占满
 * 外框 —— 不扣的话输出会比原图还大（等于把用户的原图放大了一遍，白占空间还糊）。
 */
export function cropOutputSize(
  spec: CropSpec, turns: number, imgW: number, imgH: number,
): { width: number; height: number } {
  const b = rotatedBounds(imgW, imgH, effectiveAngle(spec, turns))
  let width = Math.round(spec.rect.w * b.w)
  let height = Math.round(spec.rect.h * b.h)
  const budget = imgW * imgH
  if (width * height > budget) {
    const k = Math.sqrt(budget / (width * height))
    width = Math.max(1, Math.floor(width * k))
    height = Math.max(1, Math.floor(height * k))
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run src/core/crop.test.ts --minWorkers=1 --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/crop.ts src/core/crop.test.ts
git commit -m "feat(裁剪): 几何算式单独成层 —— 外框 / 最大内接矩形 / 输出尺寸（含不许放大）"
```

---

### Task 3: 把算式落到图上（`cropToBitmap`）

**Files:**
- Create: `src/image/crop.ts`、`src/image/crop.test.ts`

**Interfaces:**
- Consumes: `src/core/crop.ts` 的 `CropSpec` / `effectiveAngle` / `rotatedBounds` / `cropOutputSize`
- Produces: `cropToBitmap(source: ImageBitmap, spec: CropSpec, turns: number): Promise<ImageBitmap>`

- [ ] **Step 1: 写失败的测试**

⚠️ jsdom **没有真的 2D 上下文**（`getContext('2d')` 返回 null）—— 这一条**别在 jsdom 里测渲染**。
测试放在 **`@vitest-environment jsdom`** 里、只测**能测的那半**：尺寸与"没东西时怎么办"。
真正的像素对错靠 Task 6 的真机探针。

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cropToBitmap } from './crop'

describe('cropToBitmap', () => {
  it('拿不到 2D 上下文时说人话，不静默返回空图', async () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(cropToBitmap({} as ImageBitmap, { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 }, 0))
      .rejects.toThrow(/裁剪/)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/image/crop.test.ts --minWorkers=1 --maxWorkers=2`
Expected: FAIL —— 找不到 `./crop`

- [ ] **Step 3: 写 `src/image/crop.ts`**

```ts
import {
  cropOutputSize, effectiveAngle, rotatedBounds, type CropSpec,
} from '../core/crop'

/**
 * 把裁剪算式落到一张位图上（★ 2026-10-06）。
 *
 * 画法是"反过来画"：**不是**把照片转过去、而是把输出画布转回来 ——
 * 这样空角天然是空的、也不用算四个角跑到哪去了：
 *
 *   out.translate(-框左上角在外框里的像素)
 *   out.translate(外框中心)
 *   out.rotate(-θ)
 *   out.drawImage(底图, -imgW/2, -imgH/2)      // 中心对齐
 *
 * ⚠️ 作用对象是**底图 `base`**（不带参数、不带滤镜）—— 参数和滤镜之后由管线
 *    盖上去（spec §3.1）。别改成"裁渲染后的画面"。
 */
export async function cropToBitmap(
  source: ImageBitmap, spec: CropSpec, turns: number,
): Promise<ImageBitmap> {
  const angle = effectiveAngle(spec, turns)
  const bounds = rotatedBounds(source.width, source.height, angle)
  const { width, height } = cropOutputSize(spec, turns, source.width, source.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  // ✋ 拿不到上下文就**说出来** —— 返回一张空图会让用户以为"裁出来就是黑的"
  if (!ctx) throw new Error('裁剪时拿不到 2D 上下文（这张图画不出来）')

  ctx.imageSmoothingQuality = 'high'
  ctx.translate(-spec.rect.x * bounds.w, -spec.rect.y * bounds.h)
  ctx.translate(bounds.w / 2, bounds.h / 2)
  ctx.rotate((-angle * Math.PI) / 180)
  ctx.drawImage(source, -source.width / 2, -source.height / 2)

  return createImageBitmap(canvas)
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run src/image/crop.test.ts --minWorkers=1 --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/image/crop.ts src/image/crop.test.ts
git commit -m "feat(裁剪): 算式落到位图上 —— 反着画（把输出转回来），只作用在底图"
```

---

### Task 4: 裁剪的界面（框 + 第二行 + 提交）

**Files:**
- Create: `src/ui/CropOverlay.tsx`、`src/ui/CropOverlay.test.tsx`、`src/app/useLocalStep.ts`
- Modify: `src/ui/Canvas.tsx`（加 `crop` prop + 渲染框）、`src/App.tsx`（裁剪状态 + 提交 + 第二行控件）、`src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `ToolBar` / `viewLocked`；Task 2 的 `CropSpec` / `CropRect` / `inscribedRect` / `rectFromSize` / `fitAspect` / `clampRect` / `MAX_STRAIGHTEN`；Task 3 的 `cropToBitmap`
- Produces:
  - `useLocalStep(deps)` 返回 `commitLocalStep({ label, say, base }): void`
  - `Canvas` 新 prop：`crop?: { rect: CropRect; onRect: (r: CropRect) => void; aspect: number | null } | null`
  - `CropOverlay({ box, rect, aspect, onRect })`

- [ ] **Step 1: 写 `useLocalStep`（先写它的测试）**

`src/app/useLocalStep.test.ts`：这一层是**纯函数**（不挂 React，才好在 jsdom 里测），
钉的是三条产品契约：**推了新的一步 / `prompt` 是 `undefined`（不是空串）/ 参数原样带过去**。

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { localStep } from './useLocalStep'
import { pushSnapshot } from '../core/history'
import { ZERO } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

const img = (n: number) =>
  ({ bitmap: { close() {} } as unknown as ImageBitmap, width: n, height: n }) as DecodedImage

describe('本地新步骤（裁剪 / 擦除共用）', () => {
  it('★ 推一步、没有 prompt、底图换成新的、参数一个不丢', () => {
    const prev = [pushSnapshot([], {
      id: 1, label: '原图', base: img(10), params: ZERO, lut: null, isOriginal: true, thumb: '',
    })]
    const next = localStep(prev, {
      id: 2, label: '裁剪', base: img(8),
      params: { ...ZERO, exposure: 30 }, lut: null, cursorId: 1,
    })
    expect(next).toHaveLength(2)
    expect(next[1].label).toBe('裁剪')
    // ⚠️ 这一句是这条用例的全部意义：空串会让「再来一版」出现在一颗按不动的按钮上
    expect(next[1].prompt).toBeUndefined()
    expect(next[1].base.width).toBe(8)          // 换的是新底图
    expect(next[1].params.exposure).toBe(30)    // 参数原样带过去 —— 用户调好的滑块不许丢
    expect(next[1].isOriginal).toBe(false)
  })

  it('★ 站在中间那一步做本地改动：后面的被切掉（和生成那条一样）', () => {
    const prev = [
      pushSnapshot([], { id: 1, label: '原图', base: img(10), params: ZERO, lut: null, isOriginal: true, thumb: '' }),
      pushSnapshot([], { id: 3, label: '生成式编辑', prompt: 'p', base: img(10), params: ZERO, lut: null, isOriginal: false, thumb: '' }),
    ]
    const next = localStep(prev, { id: 5, label: '裁剪', base: img(8), params: ZERO, lut: null, cursorId: 1 })
    expect(next.map(s => s.id)).toEqual([1, 5])
  })
})
```

⚠️ **实现要写成一个纯函数**（不挂 React），放在 `src/app/useLocalStep.ts`：

```ts
import { cutAfter, pushSnapshot, type Snapshot } from '../core/history'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

/**
 * **本地新步骤**（★ 2026-10-06）：裁剪、擦除都从这儿走。
 *
 * 它和"生成回来"那条路（`useGeneration` 里那一段）**是同一件事**，只是没有
 * 网络那一半：切未来 → 推快照 → 换底图 → 挪光标 → 说一句话。
 * ⚠️ 切未来用的是**已有的 `cutAfter`**（生成那条用的就是它），别另写一份。
 *
 * ⚠️ **`prompt` 不许写**（连空串都不许）：没写 = 这一步没有可重跑的指令 →
 *    「再来一版」不会出现在一颗按不动的按钮上。
 * ⚠️ `params` / `lut` **原样带过去** —— 这是"用户调好的滑块不许丢"那条契约。
 */
export function localStep(prev: readonly Snapshot[], opts: {
  id: number
  label: string            // '裁剪' / '擦除'
  base: DecodedImage       // 新的底图（几何/像素改好的那一张）
  params: Adjustments
  lut: LutRef | null
  cursorId: number         // 此刻站在哪一步（>它的一律切掉，和生成那条一样）
}): Snapshot[] {
  return pushSnapshot(cutAfter(prev, opts.cursorId), {
    id: opts.id, label: opts.label, base: opts.base,
    params: opts.params, lut: opts.lut, isOriginal: false, thumb: '',
  })
}
```

- [ ] **Step 2: 写 `CropOverlay` 的测试（拖角的算法）**

`src/ui/CropOverlay.test.tsx`：给一个假的 `box`（比如 800×600 在 (0,0)）和 rect，拖动右下角
`pointerdown → window pointermove → pointerup`，断言 `onRect` 收到的 rect 变大了、而且**没越界**。

```tsx
// @vitest-environment jsdom
// 拖角：把右下角往右下拖 40px（盒 800×600）→ w 应约 +0.05、h 约 +0.0667
// 拖出去：拖到盒子外面 → 停在 1
```

（拖拽的监听要挂 `window`，和 `Canvas` 里那条拖动同一条规矩：**别用 `setPointerCapture`**。）

- [ ] **Step 3: 写 `CropOverlay.tsx`**

```tsx
/**
 * 照片上那个裁剪框（★ 2026-10-06）。
 * 它只认三件事：**照片盒子在屏幕上的位置**（`box`，由 `Canvas` 量好传进来）、
 * **归一化矩形**、**当前比例档**。拖拽全换算成那个 0~1 的矩形再喊出去 ——
 * 所以在任何屏幕尺寸上落点都对得上。
 *
 * ⚠️ 它画在**剪裁层外面**（和红圈同一个待遇）：框的把手正好挂在照片边上，
 *    剪在里头会被切掉半个。
 */
export type CropBox = { left: number; top: number; width: number; height: number }
```

内部：四个角 + 四条边共 8 个把手（`.crop-h`，各带 `data-h`），拖动时按 `MIN_SIDE` 夹取；
框内按下 = 整体平移。

- [ ] **Step 4: `Canvas` 加 `crop` prop 并渲染它**

在 `.canvas-wrap` 里、`.canvas-clip` **外面**（和 `.canvas-marker` 并列）：

```tsx
      {crop && box && (
        <CropOverlay box={box} rect={crop.rect} aspect={crop.aspect} onRect={crop.onRect} />
      )}
```

⚠️ 顺带：进裁剪时**照片要能看出"框外是暗的"** —— 暗罩画在 `CropOverlay` 里（`box` 之外
那圈用 `box-shadow: 0 0 0 9999px rgba(0,0,0,.45)` 一条搞定，别画四个矩形）。

- [ ] **Step 5: App 接上裁剪（状态 + 第二行 + 提交）**

```tsx
  /** 裁剪的现场（★ 2026-10-06）：null = 没在裁。 */
  const [crop, setCrop] = useState<{ spec: CropSpec; turns: number; aspect: number | null } | null>(null)

  /** 进裁剪：按当前底图和角度算出"默认的那个框"（居中的最大内接矩形）。 */
  const openCrop = () => {
    if (!image) return
    const angle = 0
    const size = inscribedRect(image.width, image.height, angle)
    const bounds = rotatedBounds(image.width, image.height, angle)
    setCrop({ spec: { rect: rectFromSize(size, bounds), angle }, turns: 0, aspect: null })
  }
```

第二行控件（塞进 `ToolBar` 的 children）：**比例**（自由 / 1:1 / 4:3 / 3:4 / 16:9 / 原始）、
**左转 / 右转**（改 `turns`，改完按新角度重算框）、**水平矫正滑杆**（`−15~+15`，`onInput`
里改 `spec.angle` + 重算框）、**取消**、**完成**。

提交（**这是这个工具的全部意义**）：

```tsx
  const commitCrop = async () => {
    if (!crop || !image) return
    try {
      const bitmap = await cropToBitmap(image.bitmap, crop.spec, crop.turns)
      const base: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height }
      // ⚠️ 发号器是 `idRef`（App 顶上那个），**和生成那条共用同一个** ——
      //    "消息 id 就是步骤 id"那条老约定靠它；另开一个计数器会撞号。
      const id = ++idRef.current
      setHistory(prev => localStep(prev, {
        id, label: '裁剪', base, params, lut, cursorId: cursorIdRef.current,
      }))
      setImage(base)
      moveCursor(id)                             // state + 影子 ref 一起写
      setMessages(m => [...m, { id, role: 'assistant', text: '裁好了。' }])
      setCrop(null); setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片没裁成。再试一次；还不行就换一张小一点的。')
    }
  }
```

⚠️ 文案（「裁好了。」）落笔前先读 `docs/文案规范.md`，并跟 `npm run check:copy` 对一遍。

- [ ] **Step 6: 在 App.test.tsx 里加一条端到端**

```tsx
  it('★ 裁完之后：是新的一步、还能回到上一步、参数没被重置', async () => {
    // 1) 先把亮度拖到 30（照同文件里改参数的写法）
    // 2) 进裁剪 → 完成
    // 3) 断言：history 多了一步（label '裁剪'）、当前参数还是 30、
    //    点历史转盘上原图那一格能回去（`jumpableIds` 里有两格）
  })
```

⚠️ 这条要**真跑一次裁剪**：`ImageBitmap`/`createImageBitmap` 在 jsdom 里没有 ——
测试里按本文件既有的做法**把 `src/image/crop` 整个假掉**（`vi.mock`，返回一张假的
`{width, height}` 当位图），只验**接线**（推了步、参数没动、光标挪了）。像素对不对是 Task 6 的事。

- [ ] **Step 7: 全量测试 + 类型 + 提交**

Run: `npm test -- --minWorkers=1 --maxWorkers=2`、`npm run typecheck`

```bash
git add -A src/ && git commit -m "feat(裁剪): 框 + 比例/旋转/矫正 + 完成即生成新的一步（参数不丢）"
```

（⚠️ `git add -A src/` 之后先 `git status` 看一眼，别把不相干的文件带进来。）

---

### Task 5: 对比（分屏 + 拖把手）

**Files:**
- Create: `src/ui/CompareSplit.tsx`、`src/ui/CompareSplit.test.tsx`
- Modify: `src/ui/Canvas.tsx`（加 `compareWith`）、`src/App.tsx`（原图大图 + 开关）、`src/styles.css`

**Interfaces:**
- Produces:
  - `CompareSplit({ src, transform })`：`src` = 原图的 data URL，`transform` = 和画布**同一个**变换字符串
    （⚠️ 2026-10-06 实现期更正：**原本写的 `onLeave` 划掉了** —— 组件内没有第三个出口，
    留着就是个死回调。将来真加"Esc 退出"时再补。）
  - `Canvas` 新 prop：`compareWith?: string | null`

- [ ] **Step 1: 写测试**（拖动把手改 `--split`，松手不回弹；`clip-path` 跟着变）
- [ ] **Step 2: 跑红 → 写 `CompareSplit.tsx` → 跑绿**

要点（写进实现注释）：
- 原图用 `<img>` 叠在 `.canvas-clip` **里面**、**和画布同一个 `transform`**（同一张位置上的两张图，差一点就对不齐）；
  用 `clip-path: inset(0 calc(100% - var(--split)) 0 0)` 只露左边那一半。
- 把手画在 `.canvas-wrap` 上（不随图片缩放），水平拖动改 `--split`（5%~95% 夹住）。
- 要**比原图**（和「按住看原图」同一个"原图"），**不是**上一步（spec §3.3）。

- [ ] **Step 3: App 里备那份原图（懒做）**

```tsx
  /** 对比用的原图（★ 2026-10-06）：第一次点「对比」才做，长边 ≤ 2048。
   *  ⚠️ 不许拿 `originalPreview`（那是 480 的缩略图）：分屏是并排比，
   *  左边糊右边清楚，用户会以为是我们把照片弄糊了。 */
  const [compareSrc, setCompareSrc] = useState<string | null>(null)
```

数据来源按会话状态二选一：活的会话用 `originalFileRef.current`（`createImageBitmap` → `bitmapToDataUrl(bitmap, 0.9)` → `bitmap.close()`）；
恢复出来的会话用 `fetch(sessionOriginalUrl(sessionId))`（就是"按住看原图"那条路，见 `App.tsx` 里 `setOriginalPreview` 那一段）。

- [ ] **Step 4: 把「对比」并进右下角那排（而不是只当工具行的格子）**

spec §3.3 要的是**照片右下角那排里多一颗「对比」**（美图就在缩放百分比旁边）。
做法：给 `Canvas` 传 `onCompare`（切对比态）和 `comparing`（当前在不在对比态），
在 `.zoom-bar` 里多一颗 `.zoom-compare`。工具行那颗「对比」格子**也调同一个开关**（两处入口、一个状态）。

- [ ] **Step 5: 全量测试 + 类型 + 提交**

```bash
git add -A src/ && git commit -m "feat(对比): 分屏拖把手 —— 左边原图右边现在，和画布同一套缩放平移"
```

---

### Task 6: 真机验收 + 收尾

- [ ] **Step 1: 真机探针**（`.superpowers/scratch/audit/_tools_probe.mjs`，**不进库**，照 `_zoom_probe.mjs` 的写法）

要量的数（都写进 console）：
1. 裁剪：进工具 → 视图回没回「适应窗口」、手势是否真的停用（滚轮前后 `transform` 不变）；
2. 裁一张竖图：**输出尺寸**与框一致（±1px）、**比例档**（1:1）真的对了；
3. **裁完参数还在**（先把亮度拖到 +30，裁完读面板那一格还是 30）；
4. **能回到上一步**（点转盘上原图那一格，画面回得去）；
5. 转 90° 再裁：**长宽对调**、四角没有空白；
6. 对比：拖把手 → `--split` 变；滚轮缩放 → **两张图一起缩**；
7. 截图：裁剪态 / 裁完 / 对比态（存 `shots/`）。

- [ ] **Step 2: `npm run check:layout`**（两档 × 三态照过；工具行不能把照片挤到 240×150 以下）

- [ ] **Step 3: `npm test` + `npm run typecheck` 全绿**

- [ ] **Step 4: 更新 `README.md`** 那张表（「调色面板」那一行加一句"含工具行：裁剪 / 对比"）

- [ ] **Step 5: 提交 + 写记忆**

```bash
git add README.md && git commit -m "docs: 导览里补上工具行（裁剪 / 对比）"
```

---

## 自查（写完计划后核对，已过一遍）

- **spec 覆盖**：工具行（Task 1）/ 裁剪·旋转·水平矫正（Task 2-4）/ 对比（Task 5）/ 真机验收（Task 6）。
  spec §2.2 的"第二批"（说一句改这块、局部滑杆）与 §3.2 的点修**不在本计划**——
  它们是第二份计划（点修）。
- **点修不在本计划**：工具行第一版**只有两个格子**（裁剪 / 对比）；点修加进来时是
  `ToolBar` 的 `CELLS` 多一行 + 它自己的第二行，**不动这里任何契约**。
- **类型一致性**：`CropRect` / `CropSpec` / `MAX_STRAIGHTEN` / `inscribedRect` /
  `rectFromSize` / `rotatedBounds` / `effectiveAngle` / `cropOutputSize` / `cropToBitmap` /
  `localStep` / `ToolId` / `viewLocked` / `compareWith` 全篇同名同形。
- **已知的坑（实现时踩到别慌）**：jsdom 没有 `createImageBitmap` 和 2D 上下文，
  所以 Task 4 的端到端要 `vi.mock` 掉 `src/image/crop`，像素对错交给 Task 6 的真机探针。
