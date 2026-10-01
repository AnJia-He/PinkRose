# 前端组件库（Base UI + lucide）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端手搓的通用交互件（10 格输入框、8 条滑块、一堆 emoji/字符图标、四种载体的主按钮）换成成熟组件库，并把重复的结构收进共享组件。

**Architecture:** 只用**无头**库：`@base-ui-components/react` 给行为和键盘/ARIA，`lucide-react` 给图标。DOM 结构、类名、颜色**仍然全部由我们说了算** —— 这是本计划的第一原则，因为 (a) 设计系统是自己的令牌，(b) 96 条 App 级测试**按类名找元素**。

**Tech Stack:** React 18 + Vite 6 + TypeScript + vitest（jsdom，`createRoot` + `act`，**没有 @testing-library**）。

**Spec:** `docs/superpowers/specs/2026-10-01-frontend-component-library.md`

## Global Constraints

- **依赖锁死版本**：`@base-ui-components/react` 写 **`1.0.0-rc.0`**、`lucide-react` 写 **`1.49.0`**，**不带 `^`**（前者还没 1.0，跨版本会漂）。
- **零新依赖的旧规矩只在前端这块被推翻** —— `server/`、`shared/` **一个字都不许动**。
- **类名是测试的锚点，换组件也必须保住**：`.login-field input[name="…"]`、`.login-eye`、
  `form.chat-input`、`.chat-input button`（**第一颗就是发送**）、`input[type="file"]`、
  `.save-fail button.download`、`.actions button`（**恰好三颗**）、`.bubble-jump`、`.card`、
  `.models-row`、`.gallery-thumb`、`.gallery-search`、`.detail-rename`。
- **符号不进 textContent**：`↶ ↻ +` 这类记号走 CSS/装饰（`aria-hidden` 或伪元素），
  因为读屏会念、按文字找按钮的地方会认不出。
- **颜色只许引用令牌**（`src/styles.css` 顶部 `--rose-*` / `--bg` / `--panel` / `--sp-*` …），
  组件里**不许写裸色值**。
- **文案一个字都不许改**：这一轮是换零件，不是改话。`docs/文案规范.md` 照旧管着。
- **改完 CSS/DOM 必跑**：`npx vitest run`、`node scripts/check-mobile-layout.mjs`、
  `node scripts/check-dev-urls.mjs`、`.superpowers/scratch/audit/contrast.py`。
  前三样跑不了就别提交。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/test-setup.ts`（新） | 测试环境的一次性开关（`IS_REACT_ACT_ENVIRONMENT`） |
| `src/ui/kit/Field.tsx`（新） | `<Field>` / `<TextInput>`：一格表单的**唯一**长相（label + 控件 + 注解 + 错误） |
| `src/ui/kit/kit.test.tsx`（新） | 上面这些零件自己的测试 |
| `src/ui/kit/Slider.tsx`（新） | 一条滑块（Base UI Slider + 我们的长相） |
| `src/ui/kit/Btn.tsx`（新） | 主按钮那唯一一份长相（`<button>` 和 `<a>` 两种载体共用） |
| `src/ui/LoginPage.tsx` / `ModelSettings.tsx` / `ChatPanel.tsx` / `GalleryPage.tsx` / `WorkDetailPage.tsx` / `AdjustmentPanel.tsx` / `App.tsx` | 改成用上面这些零件 |
| `src/styles.css` | 删掉被库取代的手写样式（滑块伪元素、CSS 画的符号），其余不动 |

---

### Task 1: 依赖落地 + 测试环境补齐 + 清掉「零新依赖」的旧约定

**Files:**
- Modify: `package.json`（已由本人加好两个依赖）
- Create: `src/test-setup.ts`
- Modify: `vite.config.ts`（`test.setupFiles`）
- Modify: `src/ui/Uploader.tsx:6-9`、`src/ui/LoginPage.tsx:19-21`（两处"零新依赖"的注释已经不成立）

**Interfaces:**
- Consumes: 无
- Produces: 全仓可 `import { Slider } from '@base-ui-components/react/slider'`、`import { User } from 'lucide-react'`

- [ ] **Step 1: 写一条会被"环境没配好"打红的测试**

`src/ui/kit/kit.test.tsx`：

```tsx
// @vitest-environment jsdom
/** 零件自己的测试。第一条是**环境探针**：Base UI 的组件在状态更新时会要
 *  React 的 act 环境，没配好就会刷一屏 "not configured to support act" 警告 ——
 *  那种噪声会淹掉真正有用的告警，所以先把它钉住。 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Slider } from '@base-ui-components/react/slider'
import { User } from 'lucide-react'

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

describe('零件库的地基', () => {
  it('Base UI 的滑块在我们这套 jsdom 里渲染得出原生 range', async () => {
    const c = await mount(
      <Slider.Root defaultValue={20} min={-50} max={50} aria-label="亮度">
        <Slider.Control><Slider.Track><Slider.Indicator /></Slider.Track><Slider.Thumb /></Slider.Control>
      </Slider.Root>,
    )
    const input = c.querySelector('input[type="range"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.getAttribute('aria-valuenow')).toBe('20')
  })

  it('lucide 图标吃当前字色（stroke=currentColor），不是写死的黑', async () => {
    const c = await mount(<User size={16} />)
    const svg = c.querySelector('svg')!
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })
})
```

- [ ] **Step 2: 跑它，确认现在是红的**

Run: `npx vitest run src/ui/kit/kit.test.tsx`
Expected: 第一条**过**（包已经装好了），但它会往 stderr 刷
`Warning: The current testing environment is not configured to support act(...)` ——
这就是 Step 3 要消掉的东西。（如果两条都过且**一条警告都没有**，说明环境本来就配好了，
跳过 Step 3，直接去 Step 4。）

- [ ] **Step 3: 配好 act 环境**

`src/test-setup.ts`：

```ts
/** 全局测试开关。
 *  ⚠️ React 18 的 `act()` 需要这个全局变量为 true，否则每次状态更新都会
 *  往控制台刷 "not configured to support act" —— 本来用来提示"你漏了 act"的
 *  告警会变成噪声，真出问题时反而看不见。 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
```

`vite.config.ts` 的 `test` 段加一行：

```ts
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],   // ← 新增
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
  },
```

- [ ] **Step 4: 跑全仓，确认警告没了、661 条没红**

Run: `npx vitest run 2>&1 | tail -20`
Expected: `Tests 661 passed (661)`（新的 2 条一起算进去是 663）
并且 `grep -c "not configured to support act"` 为 0。

- [ ] **Step 5: 把那两处"零新依赖"的注释改成事实**

`src/ui/Uploader.tsx` 第 6~9 行那一带、`src/ui/LoginPage.tsx` 第 19~21 行那一带，
原来写着「本项目 dependencies 永远只有 piexifjs / react / react-dom / 不引图标库」之类。
**不要删掉它们的来由**，改成：

```tsx
 *  ⚠️ 2026-10-01 起这条规矩**改了**：用户要「通用交互件一律用现成组件库」
 *  （见 docs/superpowers/specs/2026-10-01-frontend-component-library.md）。
 *  现在前端允许用 @base-ui-components/react（无头行为）+ lucide-react（图标）；
 *  **后端仍然手写、不引库**，那条没变。
```

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/test-setup.ts vite.config.ts src/ui/kit/kit.test.tsx src/ui/Uploader.tsx src/ui/LoginPage.tsx
git commit -m "chore(前端): 引入 Base UI + lucide（锁版本）；测试环境补 act 开关；改掉两处已失效的「零依赖」注释"
```

---

### Task 2: `<Field>` / `<TextInput>` —— 一格表单只有一个长相，先把登录页三格换过去

**Files:**
- Create: `src/ui/kit/Field.tsx`
- Modify: `src/ui/LoginPage.tsx:253-323`（名字 / 密码 / 邮箱三格）
- Test: `src/ui/kit/kit.test.tsx`（加两条）、`src/App.test.tsx`（**不许改**，它必须继续绿）

**Interfaces:**
- Produces：`<Field className label htmlFor hint>` 与 `<TextInput …原生 input 属性 />`
  - `Field` 渲染一个 `<div class={className}>`，里面是 `<label>` + 控件 + 可选注解
  - `TextInput` 渲染 `<input>`，由 Base UI 的 `Field.Control` 接上 `id` / `aria-labelledby` / `aria-describedby`

- [ ] **Step 1: 写会红的测试（kit 自己的 + 登录页的关联）**

追加到 `src/ui/kit/kit.test.tsx`：

```tsx
import { Field, TextInput } from './Field.tsx'

it('Field：label 和输入框是 for/id 连上的，注解是 aria-describedby 连上的', async () => {
  const c = await mount(
    <Field className="demo-field" label="名字" hint="两到二十个字">
      <TextInput name="who" defaultValue="" />
    </Field>,
  )
  const input = c.querySelector('input')!
  const label = c.querySelector('label')!
  expect(label.getAttribute('for')).toBe(input.id)          // 点字能聚焦到框
  const hint = c.querySelector('p')!
  expect(input.getAttribute('aria-describedby')).toBe(hint.id)  // 读屏会念注解
})
```

再往 `src/App.test.tsx` **之外**放一条登录页的（免得动那份大文件）——
`src/ui/kit/kit.test.tsx` 末尾：

```tsx
import { LoginPage } from '../LoginPage.tsx'

it('登录页三格：每格都是 for/id 关联（不是靠"包一层 label"隐式关联）', async () => {
  const c = await mount(<LoginPage onDone={() => {}} />)
  for (const name of ['username', 'password']) {
    const input = c.querySelector(`.login-field input[name="${name}"]`) as HTMLInputElement
    expect(input).toBeTruthy()
    const label = c.querySelector(`.login-field label[for="${input.id}"]`)
    expect(label).toBeTruthy()
  }
})
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run src/ui/kit/kit.test.tsx`
Expected: `Field` 那个导入直接报 `Failed to resolve import "./Field.tsx"`；
第二条报 `label[for=…]` 找不到（现在名字那一格的 label 是**包着** input 的隐式关联）。

- [ ] **Step 3: 写 `src/ui/kit/Field.tsx`**

```tsx
/**
 * 一格表单 = 标签 + 控件 + 注解（+ 错误）。**全站只有这一个长相**
 * （原来三套并存：隐式 label 包一层、显式 htmlFor、干脆没有 label）。
 *
 * ⚠️ 为什么走 Base UI 的 Field 而不是自己 `<div><label>…`：
 * 它会**自动**把 label / 注解 / 错误和控件用 id 连起来
 * （`for` / `aria-labelledby` / `aria-describedby`）—— 这三条是本项目
 * 2026-10-01 之前**一条都没有**的东西，手写等于又给自己派活。
 *
 * ⚠️ 类名仍然是我们的（`className` 直接落在最外层），测试按它找元素。
 */
import { Field as BaseField } from '@base-ui-components/react/field'

export function Field(props: {
  className?: string
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <BaseField.Root className={props.className}>
      <BaseField.Label>{props.label}</BaseField.Label>
      {props.children}
      {props.hint ? <BaseField.Description>{props.hint}</BaseField.Description> : null}
    </BaseField.Root>
  )
}

/** 输入框本体。`Field` 里面用它（不是裸 `<input>`），
 *  不然 Base UI 接不上 id 和 aria —— 那就白引了。 */
export function TextInput(props: React.ComponentProps<'input'>) {
  return <BaseField.Control render={<input {...props} />} />
}
```

- [ ] **Step 4: 把登录页三格换过去**

`src/ui/LoginPage.tsx`：三处 `<label className="login-field">…</label>` 连同里面那行
`<span>名字{…}</span>` 换成：

```tsx
<Field className="login-field" label={<>名字{mode === 'signup' && <Req />}</>}>
  <TextInput name="username" autoComplete="username" autoFocus
             value={username} onChange={e => setUsername(e.target.value)} />
</Field>
```

⚠️ 三条不能破：
1. **`className="login-field"` 必须留住**（`.login-field input[name="password"]` 是测试的锚点）。
2. **密码那格的结构别动**：`.login-pw` 那个 `<div>` 和那颗眼睛（`.login-eye`）是**独立的
   Task 5**，这一轮只换外层的 field 壳子；眼睛那颗 `<button>` 继续待在 `.login-pw` 里。
   （`.login-field input` 和 `.login-pw input` 两条 CSS 都还在，别删。）
3. **错误提示那一句不动**：它是**页面级**的（`.login-error` 在表单底部一次），
   不搬到每格里去 —— 那是改行为，不是换零件。

- [ ] **Step 5: 跑三条**

Run: `npx vitest run`
Expected: 全绿（含 `App.test.tsx` 那 96 条 —— 它按 `.login-field input[name=…]`、
`.login-eye` 找元素，位置没变）。**如果哪条红了，先看它是不是在钉类名/结构，别改测试。**

- [ ] **Step 6: 提交**

```bash
git add src/ui/kit/Field.tsx src/ui/kit/kit.test.tsx src/ui/LoginPage.tsx
git commit -m "refactor(前端): 抽 <Field>/<TextInput>，登录页三格先用上 —— label/注解用 id 真连起来"
```

---

### Task 3: 其余 7 格输入换过去（模型设置 4 / 搜索 / 改名 / 对话）

**Files:**
- Modify: `src/ui/ModelSettings.tsx:397-460`、`src/ui/GalleryPage.tsx:50`、
  `src/ui/WorkDetailPage.tsx:137`、`src/ui/ChatPanel.tsx:133`
- Test: `src/ui/kit/kit.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `<Field>` / `<TextInput>`
- Produces: 全站输入框只剩一套结构

- [ ] **Step 1: 写会红的测试**

```tsx
it('模型设置那几格的注解也和输入框连起来了（原来一条 aria-describedby 都没有）', async () => {
  // 渲染 ModelSettings 的成本高（要 mock 接口），所以这里只量**源码层**的约定：
  // 每一格都要过 <Field>，不许再出现手写的 <label htmlFor>。
  const src = readFileSync(new URL('../ModelSettings.tsx', import.meta.url), 'utf8')
  expect(src).toContain('<Field')
  expect(src).not.toMatch(/<label htmlFor=/)
})
```

⚠️ 这条是"源码约定"测试（和 `AdjustmentPanel.test.ts` 一个路子），因为它守的是
**"别再手搓第二套"**，而不是某个像素。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run src/ui/kit/kit.test.tsx`
Expected: 第二条 FAIL（`expect(src).toContain('<Field')` 还没写）。

- [ ] **Step 3: 四处改造**

- **`ModelSettings.tsx`** 四格：`别名` / `接口地址` / `模型名`（带 `<datalist>`）/ `钥匙`。
  `<datalist>` 照旧挂在 `<TextInput list="model-names">` 上（Base UI 的 Control 会把
  原生属性透传给 `<input>`）。
  ⚠️ **收起态那把「换一把」那一行不动**（它是 `<span>` 不是 label，源码里有注释解释过）。
- **`GalleryPage.tsx`**：搜索框**没有标签**，只有 placeholder。用
  `<Field className="gallery-field" label={<span className="gallery-sr">搜索作品</span>}>`
  —— ⚠️ 先确认 `styles.css` 里有没有 `.gallery-sr`，**没有就用 `.login-sr` 那一套**
  （1px + `clip-path` 的视觉隐藏，它在可访问性树里活着）。**别用 `display:none`。**
- **`WorkDetailPage.tsx`**：改名那一格换成 `<Field className="detail-rename-field" …>`，
  ⚠️ **Enter 提交 / Esc 取消 / blur 提交**这三条行为**一个字都不许动**（测试钉着）。
- **`ChatPanel.tsx`**：对话输入条。⚠️ 它**必须继续是 `<form className="chat-input">`
  里的 `<input name="text">`**（`say()` 这个测试辅助靠 `form.chat-input` + `input[name="text"]`
  找到它），而且 **`.chat-input button` 的第一颗必须还是发送/停止那颗**。

- [ ] **Step 4: 跑四条**

Run: `npx vitest run && node scripts/check-mobile-layout.mjs`
Expected: 全绿。手机那条特别看**「输入框在屏内」**那一项（改结构最容易把它挤出去）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/kit/kit.test.tsx src/ui/ModelSettings.tsx src/ui/GalleryPage.tsx src/ui/WorkDetailPage.tsx src/ui/ChatPanel.tsx
git commit -m "refactor(前端): 剩下 7 格输入也走 <Field> —— 全站一套结构，注解都接上 aria-describedby"
```

---

### Task 4: 8 条滑块换 Base UI Slider（手写那两套伪元素样式整段删掉）

**背景（先说清楚为什么值得换）：** 现在 `styles.css:552-573` 里有**两套**手写的
`::-webkit-slider-runnable-track / ::-webkit-slider-thumb / ::-moz-range-track /
::-moz-range-thumb`，注释自己写着「少一套就在某个浏览器上退回原生样子」。而且这 8 条
**没有任何 ARIA**（没有 `aria-valuenow`、没有名字）。Base UI 的滑块里面是一个
**原生 `<input type="range">`**（藏在拇指里），键盘、读屏、表单语义全是现成的。

**Files:**
- Create: `src/ui/kit/Slider.tsx`
- Modify: `src/ui/AdjustmentPanel.tsx:36-54`
- Modify: `src/styles.css`（删 552-573 那一整段手写样式，换成新的三条）
- Test: `src/ui/kit/kit.test.tsx`、`src/AdjustmentPanel.test.ts`（**只许增，不许改**）

**Interfaces:**
- Produces：`<Slider label value min max step onChange onLabel id />`
  - 渲染：`<label class="slider">`（**这个类名不许改**：`AdjustmentPanel.test.ts` 按源码守它）
    > `.slider-label` + 滑块 + `.slider-value`

- [ ] **Step 1: 写会红的测试（键盘改值 —— 这一条现在**根本不存在**）**

```tsx
it('滑块：键盘能改值，而且读屏能念出这是哪一条、现在多少', async () => {
  const seen: number[] = []
  const c = await mount(
    <Slider label="亮度" value={0} min={-100} max={100} step={1} onChange={v => seen.push(v)} />,
  )
  const input = c.querySelector('input[type="range"]') as HTMLInputElement
  expect(input.getAttribute('aria-valuenow')).toBe('0')          // 现在：压根没这条
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
  })
  expect(seen.at(-1)).toBe(1)                                     // 右方向键 = +1
})
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run src/ui/kit/kit.test.tsx`
Expected: `Failed to resolve import "./Slider.tsx"`。

- [ ] **Step 3: 写 `src/ui/kit/Slider.tsx`**

```tsx
/**
 * 一条滑块。**手写的两套 `::-webkit-*` / `::-moz-*` 全删了** ——
 * Base UI 的滑块里面是一个原生 `<input type="range">`，键盘、读屏、
 * 表单语义都是现成的；外面那两个 div（Track / Indicator / Thumb）由我们自己画。
 * ⚠️ 外层仍然是 `<label className="slider">`：`.slider` / `.slider.on` /
 * `.slider-value` 这几条 CSS 和 AdjustmentPanel.test.ts 都按它认人。
 */
import { Slider as BaseSlider } from '@base-ui-components/react/slider'

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  changed?: boolean
  onChange: (v: number) => void
}) {
  return (
    <label className={`slider${props.changed ? ' on' : ''}`}>
      <span className="slider-label">{props.label}</span>
      <BaseSlider.Root value={props.value} min={props.min} max={props.max}
                       step={props.step ?? 1} onValueChange={v => props.onChange(v as number)}>
        <BaseSlider.Control>
          <BaseSlider.Track><BaseSlider.Indicator /></BaseSlider.Track>
          <BaseSlider.Thumb />
        </BaseSlider.Control>
      </BaseSlider.Root>
      <span className="slider-value">{props.value > 0 ? `+${props.value}` : props.value}</span>
    </label>
  )
}
```

⚠️ `slider-value` 那串格式**照抄 AdjustmentPanel 现在的那行**（`onValueChange` 之前先把
现有实现看一遍，别凭记忆写格式化规则）。

- [ ] **Step 4: 换掉 AdjustmentPanel 里那 8 条，并删掉旧样式**

- `AdjustmentPanel.tsx`：`<input type="range">` 那段换成 `<Slider … />`，`onChange` 的
  参数名和 `applyDeltas` 的用法**照旧**。
- `styles.css`：删掉 552-573 那一段（两条 track + 两条 thumb + 一条行为规则），
  换成画**新的 div 结构**的三条（轨道 / 已选中的一段 / 拇指），仍然只引用令牌：

```css
.slider [data-orientation] { /* 由库给的容器，宽度撑满 */ }
.slider-track { height: 4px; border-radius: var(--r-pill); background: var(--line-2); }
.slider-indicator { background: var(--accent); border-radius: var(--r-pill); }
.slider-thumb { width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent); border: 2px solid var(--panel); box-shadow: var(--shadow-1); }
```

⚠️ 这里**必须给 Base UI 的零件挂上类名**（`className="slider-track"` 等，写在 Task 4
Step 3 的 Slider.tsx 里），不能靠属性选择器猜它的内部结构。

- [ ] **Step 5: 跑三条 + 眼睛看一遍**

Run: `npx vitest run && node scripts/check-mobile-layout.mjs && python .superpowers/scratch/audit/quick.py slider`
Expected: 全绿；`shots/slider-panel.png` 里 8 条滑块长得和以前一样（轨道 4px、粉圆点）。

- [ ] **Step 6: 提交**

```bash
git add src/ui/kit/Slider.tsx src/ui/kit/kit.test.tsx src/ui/AdjustmentPanel.tsx src/styles.css
git commit -m "refactor(前端): 8 条滑块换 Base UI —— 删掉两套手写伪元素样式，键盘和读屏白捡"
```

---

### Task 5: 图标统一走 lucide（`👤`、内联眼睛、`↶ ↻ ← › ↑ ✓ ⚠️`）

**Files:**
- Modify: `src/ui/LoginPage.tsx`（`EyeIcon` / `EyeOffIcon` 两个内联 SVG → `Eye` / `EyeOff`）、
  `src/App.tsx:1080`（`👤` → `User`）、`src/ui/ChatPanel.tsx`（`↶ ↻`）、
  `src/ui/ModelSettings.tsx`（`✓` `⚠️` `+`）、`src/ui/WorkDetailPage.tsx:135`（`←`）、
  `src/ui/AccountPage.tsx:127`（`›`）、`src/ui/LandingPage.tsx:105`（`↑`）
- Modify: `src/styles.css`（`.bubble-jump::before` / `.bubble-rerun::before` /
  `.models-add::before` 三条 `content:` 删掉）

**Interfaces:**
- Consumes: Task 1 装的 `lucide-react`
- Produces: 全站图标只有一种来源

- [ ] **Step 1: 写会红的测试**

```tsx
it('图标是画的，不是一个字符：顶栏那颗用户按钮里是 svg，没有文字', async () => {
  const c = await mount(<App />)          // 用 App 太重就换成挂 <User /> 的那个按钮
  const btn = c.querySelector('.user-btn')!
  expect(btn.querySelector('svg')).toBeTruthy()
  expect((btn.textContent ?? '').trim()).toBe('')
})
```

- [ ] **Step 2: 跑，确认红**（现在是 emoji，`textContent` 是 `👤`、里面没有 svg）

- [ ] **Step 3: 换**

⚠️ 三条老规矩不能破：
1. **`aria-label` 一个都不许丢**（`.user-btn` 是「用户管理」、眼睛是「显示密码/隐藏密码」
   —— 后者 `App.test.tsx:1873` 钉着）。
2. **`↶ ↻` 那两个记号原来走 CSS 伪元素**，换成图标后**必须留在"装饰"这一侧**
   （`aria-hidden`），否则读屏会念出一个符号，按文字找按钮的地方也会认不出来。
   也就是说：图标放**按钮文字前面**、`aria-hidden="true"`、原生 `textContent` 不变。
3. **`+ 添加一套`** 同理（`ModelSettings.test.tsx` 用
   `(x.textContent ?? '').trim() === '添加一套'` 找那颗按钮）—— 图标不能进 textContent。
   验证方式：换成图标之后，那条按文字找按钮的测试**必须还是绿的**。

- [ ] **Step 4: 跑全仓**

Run: `npx vitest run`
Expected: 全绿 —— **特别是 `ModelSettings.test.tsx` 那 25 条**（它们按纯文字找按钮，
是这次改动最容易被打破的地方）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/LoginPage.tsx src/ui/App.tsx src/ui/ChatPanel.tsx src/ui/ModelSettings.tsx src/ui/WorkDetailPage.tsx src/ui/AccountPage.tsx src/ui/LandingPage.tsx src/styles.css
git commit -m "refactor(前端): 图标统一走 lucide —— emoji 和内联手绘 SVG 退场，记号仍然留在装饰侧"
```

---

### Task 6: 主按钮收成一个 `<Btn>`（四种载体 / 一份长相）

**背景：** `styles.css` 里那一段注释自己写着「下面这四个**载体不同、长相必须相同**」——
而"必须相同"是靠**一条 CSS 选择器列表**维持的，抄漏一个就会漂（已经漂过：
`.login-submit` 带 `border: 0`、`.detail-download` 干脆没边框）。

**Files:**
- Create: `src/ui/kit/Btn.tsx`
- Modify: `src/App.tsx:1052/1056/1138`、`src/ui/LoginPage.tsx:326`、
  `src/ui/WorkDetailPage.tsx:175`、`src/ui/ModelSettings.tsx:482`
- Modify: `src/styles.css`（选择器列表那一段保留但改成只剩 `.btn--primary` 一条）

**Interfaces:**
- Produces：`<Btn variant="primary" | "ghost" href? onClick? …>`
  - 不传 `href` → `<button>`；传了 `href` → `<a>`（`download` 属性只有真链接带得动）

- [ ] **Step 1: 写会红的测试**

```tsx
it('详情页那颗「下载到我的电脑」—— 它是 <a>（download 只有真链接带得动），但长相走的是同一份', async () => {
  const c = await mount(<WorkDetailPage … />)   // 或者只挂 <Btn href="x" download="y" variant="primary">下载</Btn>
  const a = c.querySelector('a')!
  expect(a.className).toContain('btn')
  expect(a.className).toContain('primary')
})
```

- [ ] **Step 2: 跑，确认红**
- [ ] **Step 3: 写 `Btn.tsx`**（内部用 Base UI 的 `useRender` 或直接三元判断 `href`；
  长相类名统一成 `btn btn--primary`，CSS 里对应地把那四个选择器合成一条）
- [ ] **Step 4: 四处换过去，跑全仓 + 对比度**

Run: `npx vitest run && python .superpowers/scratch/audit/contrast.py`
Expected: 全绿、**对比度 0 处不合格**（按钮的字色/底色关系是这次最容易碰坏的，
那 7 屏 0 处不合格是硬线）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/kit/Btn.tsx src/ui/App.tsx src/ui/LoginPage.tsx src/ui/WorkDetailPage.tsx src/ui/ModelSettings.tsx src/styles.css
git commit -m "refactor(前端): 四种载体的主按钮收成一个 <Btn> —— 长相从选择器列表变成组件"
```

---

## Self-Review（写完自己过一遍）

**1. Spec 覆盖**：spec §1 的要求 → Task 1~6 全覆盖；§2 的边界 → 只做了"通用件"那一栏；
§3 的选型 → Task 1 落地；§4 的五条契约 → 每个 Task 的"不许破"清单逐条对着写；
§5 的"不做" → 没有任务碰弹层/下拉/日期。

**2. 占位符扫描**：没有 TBD / "类似 Task N" / "自行处理边界"。Task 4 Step 4 那句
"照抄现有实现"是**明确要求执行者去读那段代码**，不是省略 —— 因为格式化规则以现码为准。

**3. 类型一致**：`<Field className label hint>`、`<TextInput>`、`<Slider label value min max step changed onChange>`、`<Btn variant href>` 四个接口在 Task 2/4/6 出现时参数名一致。

**4. ⚠️ 已知没写进去的**（留给执行者现场判断，别默默跳过）：
- `LandingPage.tsx:121` 那个 range 是**拖动对比原图**的，不是滑块，**不换**。
- `Uploader.tsx` 的 `<input type="file">` 藏在 `<label className="uploader">` 里，
  **Base UI 没有替代品**（它就是原生能力），不动。
- `.notice` / `.ask` / `.save-fail` 三条横幅是**产品独有的**，spec §2 明说不用库，不动。
