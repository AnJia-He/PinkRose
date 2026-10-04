# 「调色」专业面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「调色」那一屏从"八根滑块"扩成一个像专业修图软件的面板 —— 老八根一根不动，往上加 自然饱和度 / 色彩平衡（色轮 + 三轴）/ 分离色调，分组可折叠，外加三个滑块手感（渐变轨 / 双击复零 / 数字可改）。

**Architecture:** 参数层先扩（`shared/adjustments.ts`：7 个新字段 + `PARAM_RANGE` 范围表 + `PARAM_GROUPS` 分组表），渲染层在一个 fragment shader 里加 7 个 uniform（不引入第二遍渲染、不引入纹理），界面层给 `kit/Slider` 加三个能力、新增一个色轮控件、把 `AdjustmentPanel` 改成分组结构。**CPU 对照实现（`src/core/tone.ts`）、`server/` 全部、提示词 —— 本批一个字不动。**

**Tech Stack:** React 18 + TS + Vite；WebGL2 手写渲染（无图形库）；Base UI（滑块行为）；lucide（图标）；Vitest（jsdom）；Playwright 探针。

**Spec:** `docs/superpowers/specs/2026-10-04-adjust-pro-panel-design.md`

## Global Constraints

- **老八根一根不动**：`exposure/contrast/highlights/shadows/saturation/temperature/clarity/vignette` 的字段名、界面名、顺序、范围（-100~100）、默认值都不许变。
- **零值等价（硬验收）**：7 个新参数全为 0 时，渲染结果与改动前**逐像素一致**（Task 2 有基线 diff 的步骤）。
- **旧数据不许 NaN**：老会话/老作品的 params 里没有新键 —— 入口处归一化，缺键一律当 0（允许"0"、不许 `undefined`/`NaN` 进 shader 和输入框）。
- **`src/core/tone.ts` 不动**（CPU 模型仍只六个参数：照调返回的 params 是从 `ZERO` 长的，新参数必然是 0，模型与渲染不背离）；**`server/` 全不动**（`server/prompt.ts` 自己有一份写死的列表，不跟着 `PARAM_KEYS` 走 —— 已核实）。
- **GLSL 里的注释一律 ASCII 英文**（`src/render/shader.ts` 文件头有理由：中文注释在真实设备驱动上可能编译失败）。
- 样式**只引用 `src/styles.css` 的令牌**（`--accent` / `--hair` / `--muted` / `--sp-*` / `--r-*`）。⚠️ 例外只有两处"内容色"：滑块上的**渐变轨**（色相/色温/三轴 —— 那是数据不是主题色）。
- 新文案进 `docs/文案规范.md` 的术语表（Task 8）。
- 每个任务：`npm run typecheck` 过 + 相关测试过 + 按仓库格式提交（中文、`feat(调色): …` 这类前缀）。
- 验收**用真实照片**，不用合成图（项目为这条吃过亏）。

---

## 文件结构（谁负责什么）

| 文件 | 动作 | 职责 |
|---|---|---|
| `shared/adjustments.ts` | 改 | 15 个参数：类型 / `PARAM_KEYS` / `PARAM_RANGE` / `PARAM_LABELS` / `PARAM_GROUPS` / `ZERO` / `clampAdjustments` / `toUnit` |
| `shared/adjustments.test.ts` | 改 | 上面那些的测试（含"缺键的老 params → 全 0"） |
| `src/render/shader.ts` | 改 | 一个 fragment shader 里加 7 个 uniform 与对应算式 |
| `src/render/pipeline.ts` | 改 | uniform 名单 + 每帧映射表（两处） |
| `src/ui/kit/Slider.tsx` | 改 | +`neutral`（双击复零）、+`gradient`（渐变轨）、+数字可点着改 |
| `src/ui/kit/Slider.test.tsx` | 建 | 上面三件的测试（jsdom） |
| `src/core/colorBalance.ts` | 建 | 纯函数：三轴 ↔ 色轮坐标（零和、可往返） |
| `src/core/colorBalance.test.ts` | 建 | 上面那些的测试 |
| `src/ui/ColorWheel.tsx` | 建 | 色轮控件（纯显示 + 拖点；**aria-hidden**，等价通路是三轴） |
| `src/ui/AdjustmentPanel.tsx` | 改 | 分组 + 折叠 + 色彩平衡组 + 分离色调组 |
| `src/ui/AdjustmentPanel.test.ts` | 改 | 分组/折叠/两个新组的测试 |
| `src/App.tsx` | 改 | 恢复会话时把老 params 走一遍 `clampAdjustments`（一行） |
| `src/App.test.tsx` | 改 | "老格式会话 → 不 NaN、15 根都在" 的测试 |
| `src/styles.css` | 改 | 分组/折叠/色轮/渐变轨/数字输入框的样式 |
| `docs/文案规范.md` | 改 | 术语表补三个词 |

---

### Task 1: 参数层（7 个新字段 + 范围表 + 分组表）

**Files:**
- Modify: `shared/adjustments.ts`
- Test: `shared/adjustments.test.ts`

**Interfaces:**
- Produces（后面每个任务都依赖这些**确切名字**）：
  - `type Adjustments` 新增字段：`vibrance: number`、`cbCyanRed: number`、`cbMagentaGreen: number`、`cbYellowBlue: number`、`splitHiHue: number`、`splitLoHue: number`、`splitAmount: number`
  - `PARAM_KEYS: readonly (keyof Adjustments)[]`（15 个，**顺序 = 面板显示顺序**）
  - `PARAM_RANGE: Record<keyof Adjustments, readonly [number, number]>`
  - `PARAM_GROUPS: readonly { id: 'light'|'color'|'balance'|'split'|'effects'; title: string; keys: readonly (keyof Adjustments)[] }[]`
  - `clampAdjustments` / `toUnit` / `ZERO` / `PARAM_LABELS` 覆盖 15 个键

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 shared/adjustments.test.ts
import {
  PARAM_KEYS, PARAM_RANGE, PARAM_GROUPS, PARAM_LABELS, ZERO,
  clampAdjustments, toUnit, type Adjustments,
} from './adjustments.ts'

describe('专业面板新增的 7 个参数（2026-10-04）', () => {
  it('PARAM_KEYS 是 15 个，而且顺序就是面板顺序', () => {
    expect(PARAM_KEYS).toEqual([
      'exposure', 'contrast', 'highlights', 'shadows',
      'temperature', 'vibrance', 'saturation',
      'cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue',
      'splitHiHue', 'splitLoHue', 'splitAmount',
      'clarity', 'vignette',
    ])
  })

  it('每个键都有一行范围、一个界面名，而且分组不重不漏', () => {
    for (const k of PARAM_KEYS) {
      expect(PARAM_RANGE[k], `${k} 没有范围`).toBeTruthy()
      expect(PARAM_LABELS[k], `${k} 没有界面名`).toBeTruthy()
    }
    const inGroups = PARAM_GROUPS.flatMap(g => g.keys)
    expect([...inGroups].sort()).toEqual([...PARAM_KEYS].sort())   // 不重不漏
  })

  it('色相是 0~360、强度是 0~100，其余仍是 -100~100', () => {
    expect(PARAM_RANGE.splitHiHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitLoHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitAmount).toEqual([0, 100])
    expect(PARAM_RANGE.vibrance).toEqual([-100, 100])
    expect(PARAM_RANGE.cbCyanRed).toEqual([-100, 100])
  })

  it('clamp 按各自的范围钳（色相不会被钳成 100）', () => {
    const c = clampAdjustments({ ...ZERO, splitHiHue: 400, splitLoHue: -20, splitAmount: 300, cbCyanRed: 999 })
    expect(c.splitHiHue).toBe(360)
    expect(c.splitLoHue).toBe(0)
    expect(c.splitAmount).toBe(100)
    expect(c.cbCyanRed).toBe(100)
  })

  it('★ 缺新键的老 params（只有八根）→ 全部落成 0，一个 NaN 都不许有', () => {
    // 形状照 2026-10-04 之前存进库里的那份（只有八个键）
    const legacy = {
      exposure: 10, contrast: -5, highlights: 0, shadows: 0,
      saturation: 0, temperature: 0, clarity: 0, vignette: 0,
    } as unknown as Adjustments
    const c = clampAdjustments(legacy)
    for (const k of PARAM_KEYS) expect(Number.isFinite(c[k]), `${k} 不是有限数`).toBe(true)
    expect(c.vibrance).toBe(0)
    expect(c.splitHiHue).toBe(0)
    expect(c.exposure).toBe(10)   // 老值照旧保留
  })

  it('toUnit：色相除以 360、其余除以 100', () => {
    const u = toUnit({ ...ZERO, splitHiHue: 180, splitAmount: 50, vibrance: -50, cbYellowBlue: 25 })
    expect(u.splitHiHue).toBeCloseTo(0.5)
    expect(u.splitAmount).toBeCloseTo(0.5)
    expect(u.vibrance).toBeCloseTo(-0.5)
    expect(u.cbYellowBlue).toBeCloseTo(0.25)
  })

  it('ZERO 有全部 15 个键、全是 0（新参数的中立点也是 0）', () => {
    for (const k of PARAM_KEYS) expect(ZERO[k]).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run shared/adjustments.test.ts`
Expected: FAIL —— `PARAM_RANGE` / `PARAM_GROUPS` 不存在（import 报错）、`PARAM_KEYS` 只有 8 个。

- [ ] **Step 3: 实现**

`shared/adjustments.ts` 里：
1. `Adjustments` 加 7 个字段（顺序照 Step 1 的 `PARAM_KEYS`）。
2. `PARAM_KEYS` 换成 Step 1 里那 15 个。
3. `PARAM_LABELS` 补 7 条（**这些字就是用户看到的**）：`vibrance: '自然饱和度'`、`cbCyanRed: '青 — 红'`、`cbMagentaGreen: '洋红 — 绿'`、`cbYellowBlue: '黄 — 蓝'`、`splitHiHue: '亮部颜色'`、`splitLoHue: '暗部颜色'`、`splitAmount: '强度'`。
4. 在 `PARAM_LABELS` 下面加范围表与分组表（分组顺序 = 面板顺序）：

```ts
/**
 * 每个参数的取值范围。**默认 -100~100，例外逐条写在这儿** ——
 * 面板滑块、clamp、数字输入框都从这里取，一处定义。
 * ⚠️ 加例外时想一遍：这个参数的"中立点"还是不是 0？（复零／`isChanged` 都按 0 算）
 */
export const PARAM_RANGE: Record<keyof Adjustments, readonly [number, number]> = {
  exposure: [-100, 100], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  saturation: [-100, 100], temperature: [-100, 100], clarity: [-100, 100], vignette: [-100, 100],
  vibrance: [-100, 100],
  cbCyanRed: [-100, 100], cbMagentaGreen: [-100, 100], cbYellowBlue: [-100, 100],
  splitHiHue: [0, 360], splitLoHue: [0, 360], splitAmount: [0, 100],
}

/** 面板上的分组（顺序就是显示顺序）。`id` 给界面认（比如色彩平衡那组里还要画色轮）。 */
export const PARAM_GROUPS: readonly {
  id: 'light' | 'color' | 'balance' | 'split' | 'effects'
  title: string
  keys: readonly (keyof Adjustments)[]
}[] = [
  { id: 'light', title: '光效', keys: ['exposure', 'contrast', 'highlights', 'shadows'] },
  { id: 'color', title: '色彩', keys: ['temperature', 'vibrance', 'saturation'] },
  { id: 'balance', title: '色彩平衡', keys: ['cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue'] },
  { id: 'split', title: '分离色调', keys: ['splitHiHue', 'splitLoHue', 'splitAmount'] },
  { id: 'effects', title: '效果', keys: ['clarity', 'vignette'] },
]
```

5. `ZERO` 补 7 个 0；`clampAdjustments` 与 `toUnit` 改成**逐字段列全**（保持"加字段时编译期就红"的那条性质），钳制走 `PARAM_RANGE`：

```ts
const clampTo = (k: keyof Adjustments, v: number): number => {
  const [lo, hi] = PARAM_RANGE[k]
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0
}

export function clampAdjustments(a: Adjustments): Adjustments {
  return {
    exposure: clampTo('exposure', a.exposure),
    contrast: clampTo('contrast', a.contrast),
    highlights: clampTo('highlights', a.highlights),
    shadows: clampTo('shadows', a.shadows),
    saturation: clampTo('saturation', a.saturation),
    temperature: clampTo('temperature', a.temperature),
    clarity: clampTo('clarity', a.clarity),
    vignette: clampTo('vignette', a.vignette),
    vibrance: clampTo('vibrance', a.vibrance),
    cbCyanRed: clampTo('cbCyanRed', a.cbCyanRed),
    cbMagentaGreen: clampTo('cbMagentaGreen', a.cbMagentaGreen),
    cbYellowBlue: clampTo('cbYellowBlue', a.cbYellowBlue),
    splitHiHue: clampTo('splitHiHue', a.splitHiHue),
    splitLoHue: clampTo('splitLoHue', a.splitLoHue),
    splitAmount: clampTo('splitAmount', a.splitAmount),
  }
}
```

`toUnit` 同样逐字段列全：八个老的 + `vibrance / 100`、`cb*` 各个 `/ 100`、`splitHiHue / 360`、`splitLoHue / 360`、`splitAmount / 100`。

- [ ] **Step 4: 跑测试确认它绿 + typecheck**

Run: `npx vitest run shared/adjustments.test.ts && npm run typecheck`
Expected: PASS；typecheck 0 错误（`server/` 里若因新键报错——**不该有**，`normalizeDeltas` 按 `PARAM_KEYS` 迭代、`prompt.ts` 自己一份列表；真报了就把那处读清楚再动，别顺手改 prompt）。

- [ ] **Step 5: 提交**

```bash
git add shared/adjustments.ts shared/adjustments.test.ts
git commit -m "feat(调色): 参数层加 7 个新字段 + 范围表 + 分组表（老八根一个没动）"
```

---

### Task 2: 渲染层（shader + pipeline）与**零值等价**验证

**Files:**
- Modify: `src/render/shader.ts`、`src/render/pipeline.ts`
- 新建探针（不入库）：`.superpowers/scratch/adjust-pro/_zero_equiv.py`

**Interfaces:**
- Consumes: Task 1 的 `toUnit` 返回的 15 个 unit 值。
- Produces: `TonePipeline.render(a: Adjustments)` 行为不变、多了三件新工具；shader 新增 uniform：`uVibrance / uCbCyanRed / uCbMagentaGreen / uCbYellowBlue / uSplitHiHue / uSplitLoHue / uSplitAmount`。

- [ ] **Step 1: 先拍基线（改代码之前！）**

写 `.superpowers/scratch/adjust-pro/_zero_equiv.py`（Playwright；复用 `product-test/state.json` 登录态；零花费）：

```python
#!/usr/bin/env python3
"""零值等价：全 0 参数下的画布，改动前后必须逐像素一致。
用法: python _zero_equiv.py before|after   -> shots/zero-<tag>.png"""
import sys, os
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, '..', 'product-test', 'state.json')   # product-test 在 scratch 下面（HERE=…/scratch/adjust-pro）
PHOTO = os.path.join(HERE, '..', '..', '..', 'test-photos', 'e2e_first_use.jpg')
tag = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={'width': 1440, 'height': 900}, storage_state=STATE).new_page()
    pg.goto('http://127.0.0.1:5173/app', wait_until='networkidle'); pg.wait_for_timeout(1000)
    if pg.locator('.actions button', has_text='新的一张').count():
        pg.locator('.actions button', has_text='新的一张').click(); pg.wait_for_timeout(600)
    pg.set_input_files('input[type=file]', PHOTO)
    pg.wait_for_selector('canvas', timeout=15000); pg.wait_for_timeout(1500)
    data = pg.evaluate("() => document.querySelector('canvas').toDataURL('image/png')")
    import base64
    out = os.path.join(HERE, 'shots', f'zero-{tag}.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(base64.b64decode(data.split(',')[1]))
    print('存到', out)
    b.close()
```

Run: `python .superpowers/scratch/adjust-pro/_zero_equiv.py before`
Expected: 产出 `shots/zero-before.png`（这一步**必须在动 shader 之前跑**）。

- [ ] **Step 2: 改 `src/render/shader.ts`**

(a) uniform 声明区追加：

```glsl
uniform float uVibrance;
uniform float uCbCyanRed;
uniform float uCbMagentaGreen;
uniform float uCbYellowBlue;
uniform float uSplitHiHue;
uniform float uSplitLoHue;
uniform float uSplitAmount;
```

(b) 在 `linearToSrgb` 后面加一个小助手（注释英文）：

```glsl
// Hue (0..1) -> a pure chroma tint (luma removed), so applying it shifts
// color without changing brightness.
vec3 hueTint(float h) {
  vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
  vec3 p = abs(fract(vec3(h) + k) * 6.0 - 3.0);
  vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
  return rgb - vec3(dot(rgb, LUMA));
}
```

(c) 主链按 spec §4 的插入点改（**只加行，不改老行**）：

- 「1. Temperature」之后：

```glsl
  // 1.5 Color balance -- one shift per channel, same style as temperature.
  c.r += uCbCyanRed * 0.10;
  c.g += uCbMagentaGreen * 0.10;
  c.b += uCbYellowBlue * 0.10;
```

- 「5. Saturation」之后：

```glsl
  // 5.5 Vibrance -- push the DULL colors, leave the saturated ones alone
  //     (that is the whole difference from saturation).
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float satNow = mx > 1e-4 ? (mx - mn) / mx : 0.0;
  float l2b = dot(c, LUMA);
  c = vec3(l2b) + (c - vec3(l2b)) * (1.0 + uVibrance * (1.0 - satNow) * 1.2);
```

- 「6. Vignette」之前：

```glsl
  // 6.5 Split toning -- tint highlights and shadows separately.
  //     At amount 0 this is an exact identity (adds vec3(0)).
  float l3 = dot(c, LUMA);
  float wHi = smoothstep(0.45, 1.0, l3);
  float wLo = 1.0 - smoothstep(0.0, 0.55, l3);
  c += hueTint(uSplitHiHue) * (wHi * uSplitAmount * 0.25);
  c += hueTint(uSplitLoHue) * (wLo * uSplitAmount * 0.25);
```

- [ ] **Step 3: 改 `src/render/pipeline.ts` 两处**

```ts
const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
  'uVibrance', 'uCbCyanRed', 'uCbMagentaGreen', 'uCbYellowBlue',
  'uSplitHiHue', 'uSplitLoHue', 'uSplitAmount',
] as const
```

`render()` 里那张 map 追加：

```ts
      uVibrance: u.vibrance,
      uCbCyanRed: u.cbCyanRed,
      uCbMagentaGreen: u.cbMagentaGreen,
      uCbYellowBlue: u.cbYellowBlue,
      uSplitHiHue: u.splitHiHue,
      uSplitLoHue: u.splitLoHue,
      uSplitAmount: u.splitAmount,
```

- [ ] **Step 4: 零值等价验证**

Run: `npm run typecheck && python .superpowers/scratch/adjust-pro/_zero_equiv.py after`
然后比对：

```bash
python - <<'PY'
from PIL import Image, ImageChops
a = Image.open('.superpowers/scratch/adjust-pro/shots/zero-before.png').convert('RGB')
b = Image.open('.superpowers/scratch/adjust-pro/shots/zero-after.png').convert('RGB')
diff = ImageChops.difference(a, b)
print('尺寸一致:', a.size == b.size)
print('逐像素最大差:', diff.getextrema())
PY
```

Expected: 尺寸一致、**最大差 (0,0,0)**。⚠️ 不是 0 就别往下走 —— 那是"新工具在零值处不生效"的 bug，先查插入的算式（`uVibrance=0` 时乘数必须是 1.0、分离色调加的是 0）。

- [ ] **Step 5: 手动看一眼新工具真的有反应**

浏览器里（或探针）：拖几根新滑块/色轮 → 画面必须变，而且**不许明显变暗/变脏**（先粗看；细调在 Task 8 用真图验收）。
Expected: 色彩平衡往红推 → 整体偏暖红；分离色调亮部选橙、强度拉高 → 高光泛橙；自然饱和度拉高 → 淡色变艳、已经很艳的地方没炸。

- [ ] **Step 6: 提交**

```bash
git add src/render/shader.ts src/render/pipeline.ts
git commit -m "feat(调色): 三件新工具进渲染链（同一条 shader，零值等价已验证）"
```

---

### Task 3: `kit/Slider` 三件套（双击复零 / 数字可改 / 渐变轨）

**Files:**
- Modify: `src/ui/kit/Slider.tsx`、`src/styles.css`
- Test: `src/ui/kit/Slider.test.tsx`（新建）

**Interfaces:**
- Produces（Task 5 会用）：
  - `Slider` 新 props：`neutral?: number`（双击回到哪，默认 0）、`gradient?: string`（CSS 渐变串，给了就不画填充段）
  - 行为：**双击滑块本体**（轨道/圆点）→ `onChange(neutral)`；**点数字**→ 变输入框，`Enter`/失焦提交、`Esc` 取消、非法输入当取消、超范围钳到边界。

- [ ] **Step 1: 写失败的测试**

```tsx
// src/ui/kit/Slider.test.tsx（照 kit.test.tsx 的写法：render + fireEvent）
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Slider } from './Slider.tsx'

describe('Slider 三件套', () => {
  it('双击滑块本体 → onChange(neutral)（默认 0）', () => {
    const onChange = vi.fn()
    const { container } = render(<Slider label="亮度" value={30} min={-100} max={100} onChange={onChange} />)
    fireEvent.doubleClick(container.querySelector('.slider-control')!)
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('双击 → 回到传进来的 neutral（色相带这类用得上）', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Slider label="亮部颜色" value={180} min={0} max={360} neutral={30} onChange={onChange} />)
    fireEvent.doubleClick(container.querySelector('.slider-control')!)
    expect(onChange).toHaveBeenCalledWith(30)
  })

  it('点数字 → 输入 42 回车 → onChange(42)', () => {
    const onChange = vi.fn()
    const { container } = render(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    fireEvent.click(container.querySelector('.slider-value')!)
    const input = container.querySelector('input.slider-edit') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(42)
  })

  it('超范围钳到边界；非法输入当取消（不调 onChange）', () => {
    const onChange = vi.fn()
    const { container } = render(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    fireEvent.click(container.querySelector('.slider-value')!)
    let input = container.querySelector('input.slider-edit') as HTMLInputElement
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(100)
    fireEvent.click(container.querySelector('.slider-value')!)
    input = container.querySelector('input.slider-edit') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)   // 只有上面那次
  })

  it('Esc 取消，不改值', () => {
    const onChange = vi.fn()
    const { container } = render(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    fireEvent.click(container.querySelector('.slider-value')!)
    const input = container.querySelector('input.slider-edit') as HTMLInputElement
    fireEvent.change(input, { target: { value: '55' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('gradient 传到轨道上（渐变轨靠它）', () => {
    const { container } = render(
      <Slider label="色温" value={0} min={-100} max={100} gradient="linear-gradient(90deg,#00f,#ff0)" onChange={() => {}} />)
    const track = container.querySelector('.slider-track') as HTMLElement
    expect(track.getAttribute('style') ?? '').toContain('linear-gradient')
  })
})
```

> ⚠️ **测试写法勘误（2026-10-04 预检时发现，照这个来）**：上面那段代码里的
> `@testing-library/react` / `render` / `fireEvent` **这个项目没有这个依赖**
> （零新增依赖是规矩）。**照 `src/ui/kit/kit.test.tsx` 现成的写法**改写：
> 文件头 `// @vitest-environment jsdom`；用它的 `mount()`（`createRoot` + `await act`）；
> 往受控输入框里打字要**用原型上的 value setter 绕 React 的 tracker**
> （`App.test.tsx` 里那个 `type()` 助手就是干这个的，抄它）；
> 双击用 `dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`；
> 回车/Esc 用 `dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`。
> **断言（断的是什么都别改）一个字不动** —— 变的只是驱动方式。

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/ui/kit/Slider.test.tsx`
Expected: FAIL（drag 行为在、但双击/输入框/渐变都还没有）。

- [ ] **Step 3: 实现 `Slider.tsx`**

要点（其余照旧）：
- props 追加 `neutral?: number`、`gradient?: string`。
- 最外层 `<label>` 上**不要**挂双击（数字就在它里面）——双击挂在 `<BaseSlider.Control className="slider-control">` 上。
- 数字那格：`editing === null` 时渲染 `<span className="slider-value" aria-hidden="true" onClick={() => setEditing(String(props.value))}>`；否则渲染 `<input className="slider-edit" autoFocus value={editing} onChange=… onKeyDown=… onBlur=…>`。
  - `commit()`：`const v = Number(editing)`；`Number.isFinite(v)` 才 `onChange(Math.max(min, Math.min(max, v)))`；然后 `setEditing(null)`。
  - `Enter` → commit；`Escape` → `setEditing(null)`；失焦 → commit。
  - ⚠️ **保留 `aria-hidden`**：这格是给鼠标用户的快捷输入（键盘用户用方向键微调，那才是可达通路）；写进注释。
- `gradient` 时给 track 挂 `style={{ background: gradient }}`，并**不渲染** `BaseSlider.Indicator`（填充段会和渐变打架）。

`styles.css`：`.slider-edit { width: 4.5em; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; padding: 0 2px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--panel); color: var(--text); }`

- [ ] **Step 4: 跑测试 + typecheck**

Run: `npx vitest run src/ui/kit/ && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/kit/Slider.tsx src/ui/kit/Slider.test.tsx src/styles.css
git commit -m "feat(调色): 滑块三件套 —— 双击复零 / 数字可点着改 / 渐变轨"
```

---

### Task 4: 色轮（纯函数 + 控件）

**Files:**
- Create: `src/core/colorBalance.ts`、`src/core/colorBalance.test.ts`、`src/ui/ColorWheel.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Produces（Task 5 用）：
  - `axesToWheel(a: Pick<Adjustments, 'cbCyanRed' | 'cbMagentaGreen' | 'cbYellowBlue'>): { x: number; y: number }`（x 向右 = 偏红，y 向上 = 偏蓝；都在 -1~1）
  - `wheelToAxes(x: number, y: number): { cbCyanRed: number; cbMagentaGreen: number; cbYellowBlue: number }`（半径钳到 1；三轴**零和**、各自 -100~100）
  - `<ColorWheel axes={…} onChange={next => …} />`（`aria-hidden`；双击回中）

- [ ] **Step 1: 写纯函数的失败测试**

```ts
// src/core/colorBalance.test.ts
import { describe, it, expect } from 'vitest'
import { axesToWheel, wheelToAxes } from './colorBalance.ts'

const zero = { cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0 }

describe('三轴 ↔ 色轮', () => {
  it('零轴在圆心', () => {
    expect(axesToWheel(zero)).toEqual({ x: 0, y: 0 })
  })

  it('★ 拖到"红"方向 → 青—红轴为正，且三轴零和', () => {
    const a = wheelToAxes(1, 0)
    expect(a.cbCyanRed).toBeGreaterThan(0)
    expect(Math.abs(a.cbCyanRed + a.cbMagentaGreen + a.cbYellowBlue)).toBeLessThanOrEqual(2)
  })

  it('★ 往返一致（轴 → 轮 → 轴，误差 ±2 以内）', () => {
    const cases = [
      { cbCyanRed: 60, cbMagentaGreen: -30, cbYellowBlue: -30 },
      { cbCyanRed: -20, cbMagentaGreen: 10, cbYellowBlue: 10 },
      { cbCyanRed: 0, cbMagentaGreen: -45, cbYellowBlue: 45 },
    ]
    for (const c of cases) {
      const { x, y } = axesToWheel(c)
      const back = wheelToAxes(x, y)
      expect(Math.abs(back.cbCyanRed - c.cbCyanRed), JSON.stringify(c)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.cbMagentaGreen - c.cbMagentaGreen)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.cbYellowBlue - c.cbYellowBlue)).toBeLessThanOrEqual(2)
    }
  })

  it('超出圆外的点被钳回圆内（拖到角上不会爆表）', () => {
    const a = wheelToAxes(3, 3)
    for (const v of Object.values(a)) expect(Math.abs(v)).toBeLessThanOrEqual(100)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/core/colorBalance.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/core/colorBalance.ts`**

思路（**零和**是构造出来的，不是钳出来的）：

```ts
// 两个正交的"色偏方向"（每个方向的三个分量和 = 0 —— 只推颜色、不动明暗）
const RED_DIR  = [ 2 / 3, -1 / 3, -1 / 3] as const   // 红 ←→ 青
const BLUE_DIR = [-1 / 3, -1 / 3,  2 / 3] as const   // 蓝 ←→ 黄
```
- `axesToWheel`：把三轴当向量，分别投影到两个方向上（点积 / 100），半径超过 1 时按比例缩到 1。
- `wheelToAxes`：`(x, y)` 先 `r = Math.hypot(x, y)` 超 1 就归一化，然后
  `axes[i] = (x * RED_DIR[i] + y * BLUE_DIR[i]) * 100`，各自 `Math.round` 钳到 ±100。
- 注释里写清：**这个映射是可往返的近似**（投影用的两个方向不正交，往返误差 ≤2 —— 测试钉着），
  零和是"构造性质"、取整后允许 ±1 的偏差。

- [ ] **Step 4: 写 `ColorWheel.tsx` + 样式**

- 一个 `div.color-wheel`：`background: conic-gradient(#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)`；里面一个 `span.color-wheel-dot` 按 `axesToWheel` 定位。
- 拖动：`onPointerDown` → `setPointerCapture` → `onPointerMove` 里把坐标换算成 `(x, y)`（相对圆心、除以半径、y 取反）→ `onChange(wheelToAxes(x, y))`。
- **双击回中**：`onDoubleClick` → `onChange({ cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0 })`。
- ★ **给容器挂 `data-x` / `data-y`**（就是圆点当前坐标的字符串形式）—— Task 5 的
  "套预设后色轮回中心"那条测试读它。（两个属性都要写。）
- `aria-hidden="true"` + 一条注释：**等价通路是旁边三根轴**（键盘/读屏走那三根）。
- 样式（`styles.css`）：`.color-wheel { width: 88px; height: 88px; border-radius: 50%; position: relative; box-shadow: inset 0 0 0 1px var(--hair); touch-action: none; }`；`.color-wheel-dot { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid rgba(0,0,0,.35); transform: translate(-50%, -50%); }`

- [ ] **Step 5: 跑测试 + typecheck**

Run: `npx vitest run src/core/colorBalance.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/colorBalance.ts src/core/colorBalance.test.ts src/ui/ColorWheel.tsx src/styles.css
git commit -m "feat(调色): 色轮控件（三轴的二维视图，零和、可往返；等价通路是那三根轴）"
```

---

### Task 5: 面板改成分组 + 两个新组

**Files:**
- Modify: `src/ui/AdjustmentPanel.tsx`、`src/styles.css`
- Create: `src/ui/AdjustmentPanel.behavior.test.tsx`（**行为测试另开一个文件** ——
  现有那份 `AdjustmentPanel.test.ts` 不能加 jsdom 头：它用
  `new URL('./AdjustmentPanel.tsx', import.meta.url)` 读源码，jsdom 下那条路拼不出
  `file://`，会当场红。**它一个字都不用改**，而且它的"没有自己写死标签"那条
  **自动覆盖新加的 7 个标签**。）

**Interfaces:**
- Consumes: Task 1 的 `PARAM_GROUPS / PARAM_RANGE / PARAM_LABELS`；Task 3 的 `Slider(neutral, gradient)`；Task 4 的 `ColorWheel / axesToWheel / wheelToAxes`。

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 src/ui/AdjustmentPanel.test.ts（那是"读源码"的测试，这里补行为测试——
// 用 @testing-library 渲染组件，包一个受控壳子）
import { render, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import AdjustmentPanel from './AdjustmentPanel.tsx'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'

function Harness() {
  const [v, setV] = useState<Adjustments>(ZERO)
  return <AdjustmentPanel value={v} onChange={setV} onReset={() => setV(ZERO)} onMatchReference={() => {}} />
}

describe('面板的分组（2026-10-04）', () => {
  it('五个组标题都在（光效/色彩/色彩平衡/分离色调/效果）', () => {
    const { container } = render(<Harness />)
    const titles = [...container.querySelectorAll('.panel-group-title')].map(e => e.textContent)
    expect(titles).toEqual(['光效', '色彩', '色彩平衡', '分离色调', '效果'])
  })

  it('15 根滑块都在（每组里数量对）', () => {
    const { container } = render(<Harness />)
    expect(container.querySelectorAll('.slider').length).toBe(15)
  })

  it('色彩平衡那组里有一个色轮 + 三根轴', () => {
    const { container } = render(<Harness />)
    const group = [...container.querySelectorAll('.panel-group')]
      .find(g => g.querySelector('.panel-group-title')?.textContent === '色彩平衡')!
    expect(group.querySelector('.color-wheel')).toBeTruthy()
    const labels = [...group.querySelectorAll('.slider-label')].map(e => e.textContent)
    expect(labels).toEqual(['青 — 红', '洋红 — 绿', '黄 — 蓝'])
  })

  it('★ 点组标题 → 收起；再点 → 展开', () => {
    const { container } = render(<Harness />)
    const head = container.querySelector('.panel-group-head')!
    const before = container.querySelectorAll('.slider').length
    fireEvent.click(head)
    expect(container.querySelectorAll('.slider').length).toBeLessThan(before)
    fireEvent.click(head)
    expect(container.querySelectorAll('.slider').length).toBe(before)
  })

  it('分离色调的三根用各自的范围（色相到 360，强度到 100）', () => {
    const { container } = render(<Harness />)
    const group = [...container.querySelectorAll('.panel-group')]
      .find(g => g.querySelector('.panel-group-title')?.textContent === '分离色调')!
    const ranges = [...group.querySelectorAll('input[type=range]')]
      .map(i => (i as HTMLInputElement).getAttribute('max'))
    expect(ranges.filter(m => m === '360')).toHaveLength(2)   // 两条色相带
    expect(ranges).toContain('100')                           // 强度
  })

  it('★ 套一个预设 → 新参数一并归零（不许"套了预设色轮还留着"）', () => {
    const { container } = render(<Harness />)
    const group = [...container.querySelectorAll('.panel-group')]
      .find(g => g.querySelector('.panel-group-title')?.textContent === '色彩平衡')!
    const ax = group.querySelector('input[type=range]') as HTMLInputElement
    fireEvent.change(ax, { target: { value: '60' } })
    expect(container.querySelector('.color-wheel')!.getAttribute('data-x')).not.toBe('0')
    fireEvent.click([...container.querySelectorAll('.presets button')][0]!)   // 点第一个预设
    expect(container.querySelector('.color-wheel')!.getAttribute('data-x')).toBe('0')   // 色轮回中心 = 三轴归零
  })
```
（最后一条依赖 `ColorWheel` 把圆心的坐标挂在 `data-x` / `data-y` 上供测试读 —— Task 4 实现时顺手加上，两个属性都写上。）

> ⚠️ **测试写法勘误（2026-10-04 预检时发现，照这个来）**：上一段代码里的
> `@testing-library/react` / `render` / `fireEvent` **这个项目没有**（零新增依赖）——
> 照 `src/ui/kit/kit.test.tsx` 的写法改写（`// @vitest-environment jsdom` +
> 自己写 `mount()`：`createRoot` + `await act`；点击用 `.click()`；别的照
> `kit.test.tsx` 与 `App.test.tsx` 的既有套路）。**断言一个字不动。**
> 另外"套预设后色轮归零"那条：**不要模拟拖滑块**（Base UI 的受控滑块在 jsdom 里
> 不好驱动）—— 给 `Harness` 留一个模块级 `setFromTest`（`const [v, setV] = useState…`
> 后面写 `setFromTest = setV`），测试里直接 `await act(() => setFromTest({ ...ZERO, cbCyanRed: 60 }))`
> 把值置出去，再点预设、看 `data-x` 回没回 `0`。

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/ui/AdjustmentPanel.behavior.test.tsx`
Expected: FAIL（还没有 `.panel-group`）。

- [ ] **Step 3: 改 `AdjustmentPanel.tsx`**

结构（保留现有的头/预设/照着这张调，只把"八条滑块"那一段换成组）：

```tsx
const GRADIENTS: Partial<Record<keyof Adjustments, string>> = {
  temperature: 'linear-gradient(90deg, #2f7cf6, #ececf0 50%, #ffc83d)',
  cbCyanRed: 'linear-gradient(90deg, #22c1c3, #ececf0 50%, #ff4d4d)',
  cbMagentaGreen: 'linear-gradient(90deg, #e5399a, #ececf0 50%, #4caf50)',
  cbYellowBlue: 'linear-gradient(90deg, #ffcc00, #ececf0 50%, #2f7cf6)',
  splitHiHue: 'linear-gradient(90deg,#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)',
  splitLoHue: 'linear-gradient(90deg,#ff2d2d,#ffef00,#00e000,#00e5e5,#0048ff,#e000ff,#ff2d2d)',
}

const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

<div className="panel-groups">
  {PARAM_GROUPS.map(g => (
    <section className="panel-group" key={g.id}>
      <button className="panel-group-head" aria-expanded={!collapsed.has(g.id)}
        onClick={() => setCollapsed(prev => {
          const next = new Set(prev)
          next.has(g.id) ? next.delete(g.id) : next.add(g.id)
          return next
        })}>
        <span className="panel-group-title">{g.title}</span>
        <ChevronDown size={14} className={collapsed.has(g.id) ? 'chev folded' : 'chev'} aria-hidden="true" />
      </button>
      {!collapsed.has(g.id) && (
        <div className="panel-group-body">
          {g.id === 'balance' && (
            <ColorWheel
              axes={{ cbCyanRed: value.cbCyanRed, cbMagentaGreen: value.cbMagentaGreen, cbYellowBlue: value.cbYellowBlue }}
              onChange={next => onChange({ ...value, ...next })} />
          )}
          {g.keys.map(k => (
            <Slider key={k} label={PARAM_LABELS[k]} value={value[k]}
              min={PARAM_RANGE[k][0]} max={PARAM_RANGE[k][1]}
              changed={isChanged(value, k)} gradient={GRADIENTS[k]}
              onChange={v => onChange({ ...value, [k]: v })} />
          ))}
        </div>
      )}
    </section>
  ))}
</div>
```
- `ChevronDown` 从 `lucide-react` 来（项目已用）。
- **分组标题一个字都不许和 `PARAM_LABELS` 里的值撞**（`AdjustmentPanel.test.ts` 那条"没有自己写死标签"会管到这个 —— 它现在会连 15 个标签一起查；组标题不在 `PARAM_LABELS` 里，安全）。

`styles.css`：把 `.panel-sliders` 那组规则换掉（保留旧注释里"分栏只发生在滑块这一层"的教训）：

```css
.panel-groups { display: flex; flex-direction: column; }
.panel-group + .panel-group { border-top: 1px solid var(--hair); margin-top: var(--sp-4); padding-top: var(--sp-3); }
.panel-group-head { display: flex; align-items: center; justify-content: space-between; width: 100%;
  background: none; border: 0; border-radius: 0; padding: 2px 0; color: var(--muted);
  font-size: 12px; letter-spacing: .06em; transform: none; }
.panel-group-head .chev { transition: transform var(--dur-1) var(--ease); }
.panel-group-head .chev.folded { transform: rotate(-90deg); }
.panel-group-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0 var(--sp-5); align-items: start; }
.color-wheel { grid-row: span 3; }   /* 色轮占三行，跟三根轴并排 */
```

- [ ] **Step 4: 跑测试 + 全套**

Run: `npx vitest run src/ui/AdjustmentPanel.test.ts && npx vitest run && npm run typecheck`
Expected: 全绿。**可能有红**：`App.test.tsx` 里凡是数滑块条数/按 `.slider` 找第 N 条的 —— 一条条改成"按标签找"（`rowByLabel` 那种），**不许**把断言删掉或改弱。

- [ ] **Step 5: 提交**

```bash
git add src/ui/AdjustmentPanel.tsx src/ui/AdjustmentPanel.test.ts src/styles.css
git commit -m "feat(调色): 面板分组（光效/色彩/色彩平衡/分离色调/效果）+ 可折叠"
```

---

### Task 6: 老数据兼容（恢复会话时归一化）

**Files:**
- Modify: `src/App.tsx`（恢复那一段）、`src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `clampAdjustments`。

- [ ] **Step 1: 写失败的测试**

```tsx
// 追加到 src/App.test.tsx 的「恢复」那组里。夹具形状照 withSessions 现有写法，
// **关键是 params 只有八个键**（照 2026-10-04 之前存进库里的样子）：
const LEGACY_SESSION = {
  id: 9001, title: null, originalName: '老照片.jpg',
  createdAt: 0, updatedAt: 0, hasThumb: false, stepCount: 1,
  steps: [{
    id: 1, label: '原图', at: 0, reusesPrev: false,
    params: { exposure: 0, contrast: 0, highlights: 0, shadows: 0,
              saturation: 0, temperature: 0, clarity: 0, vignette: 0 },
  }],
}

it('★ 老格式的会话（params 只有八根）接回来：15 根滑块都在、一个 NaN 都没有', async () => {
  withSessions([LEGACY_SESSION])
  await renderApp()
  // ① 面板上 15 根都在（新键缺失 → 落成 0，而不是消失）
  expect(container.querySelectorAll('.slider').length).toBe(15)
  // ② 屏幕上不许出现 NaN（undefined 一路飘进输入框/画布时长的就是这个样子）
  expect(container.textContent ?? '').not.toContain('NaN')
})
```
（恢复之后 App 落在修图页、面板在 `/app/adjust`；照「恢复」那组现有用例的走法切到调色那一屏再断言。）

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/App.test.tsx -t 老格式的会话`
Expected: FAIL（`vibrance` 是 `undefined` → 面板上出现 `NaN` 或断言失败）。

- [ ] **Step 2b: ★ 预检/执行时补的裁定 —— 老**作品**的详情页也要归一化（会话那条支线的孪生）**

同一味病、另一条路：`WorkDetailPage.tsx` 用 `isChanged` 列「这张图怎么来的」那张表，
而**老作品**存下来的 `recipe.params` 只有八个键 —— 新键是 `undefined`，
`undefined !== 0` 会让它**多列 7 行**（「自然饱和度 undefined」这种）。
先写测试（照该文件/详情页现有测试的夹具写法，喂一条"八键 recipe"的老作品）：
表里**只有真改过的那几行**、没有新参数的幽灵行。跑红之后修：那一页算表之前
`const params = clampAdjustments(recipe.params)`（一行，和 App 那边同款）。

- [ ] **Step 3: 改 `src/App.tsx`**

恢复循环里那两处 `params: s.params` / `params: prev.params` 的构造点，统一走一次归一化：

```ts
import { clampAdjustments } from '../shared/adjustments.ts'
// …恢复循环里：
params: clampAdjustments(s.params),
```
（`prev.params` 那条本来就是同一批归一化过的，跟着走同一条路即可。）
注释一句话：**老数据缺新键 —— 归一化是唯一入口，别让 undefined 进状态**。

- [ ] **Step 4: 跑测试 + 全套**

Run: `npx vitest run src/App.test.tsx && npx vitest run && npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "fix(调色): 老会话的 params 缺新键 —— 恢复时归一化（不许 NaN 进状态和画布）"
```

---

### Task 7: 探针 + 真实照片验收 + 文案

**Files:**
- Modify: `docs/文案规范.md`（术语表）
- 不改代码；产出验收截图与结论

- [ ] **Step 1: 跑三个探针**

```bash
npm run check:layout      # 两档 × 三态：照片不被挤、面板自己滚、窄屏不溢出
npm run check:copy        # 通读一遍新文案（「自然饱和度 / 色彩平衡 / 分离色调 / 亮部颜色 / 强度」）
python .superpowers/scratch/audit/adjust_flow.py      # 真浏览器：调色那一屏的交互
python .superpowers/scratch/audit/r9_e2e.py           # 全链路 37 项（预设、保存、详情页）
```
Expected: `check:layout` 全过；`adjust_flow` 全过；`r9_e2e` 除那两条已知的性能线外全过。
⚠️ `check:layout` 会现注册临时账号（限流 20/时）—— 连着跑别超过两三次。

- [ ] **Step 2: 真实照片三张（合成图不算）**

从 `test-photos/`（或用户相册里挑三张真图）：
1. **白炽灯下的偏色照片** → 用「色彩平衡」往蓝推，白墙回中性；
2. **落日/夕阳** → 「分离色调」亮部挑橙、强度适中，暖而不脏；
3. **人像** → 「自然饱和度」拉高：肤色不塑料、背景的灰绿变鲜活。
每张存前后对照到 `.superpowers/scratch/adjust-pro/shots/`，**自己先看**：有没有变脏/变糊/断层。

- [ ] **Step 3: 手感走一遍**

真浏览器里：双击每根滑块复零 ✓；点数字输 42 回车 ✓、输 999 变边界 ✓、Esc 取消 ✓；
Tab 键能走到每一根滑块、色轮不抢焦点 ✓。

- [ ] **Step 4: `docs/文案规范.md` 术语表补三条**

`自然饱和度` / `色彩平衡` / `分离色调`（各一句人话解释，和落地页、App 里用**同一个词**）。

- [ ] **Step 5: 提交**

```bash
git add docs/文案规范.md
git commit -m "docs(文案): 术语表补 自然饱和度 / 色彩平衡 / 分离色调"
```

---

## 收尾（全部任务做完之后）

- [ ] `npx vitest run` 全绿 + `npm run typecheck` + `npm run check:layout` + `check:copy` 过一遍。
- [ ] 零值等价的基线 diff 再跑一次（`_zero_equiv.py after` → 与 `before` 比，期望 0）。
- [ ] ⚠️ 后端改动？**本批没有** —— 不需要重启服务（但前端是 HMR，直接生效）。
- [ ] 逐条对一遍 spec §2.1 的六件事、§8 的九条验收，缺哪条补哪条。
