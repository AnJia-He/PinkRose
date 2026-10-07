# 全站「完成度升级」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「表现层三把尺子」（节奏 B·呼吸 / 字号 9 档 / 微修六条）落进 `styles.css` 与 `landing.css`，全站对齐到 2026-10-07 画板上逐轮确认过的样子。

**Architecture:** 纯表现层改造。不碰结构、布局、交互、文案、颜色主体系（spec §4）。节奏的精确数值以三轮画板注入的样式表原件为准（`board-shots-1/2/3.mjs`），本计划把每一处 before→after 逐条写死。

**Tech Stack:** 原生 CSS（`src/styles.css` 3176 行、`src/landing.css` ~390 行）、React 18 + TS（只有 4 处 tsx 单行改动）、vitest（新增一个"尺子守卫"测试，用字符串哨兵读 CSS——仓库已有先例 `CompareSplit.test.tsx`）。

**Spec:** `docs/superpowers/specs/2026-10-07-finish-upgrade-design.md`

## Global Constraints

- **只动表层**：任何一步若需要改结构/布局/文案/交互 → 停下重议（spec §4）。
- **门面例外**：`landing.css` 的字重 380 / 500 / 600 是它的合法语域，**不许**被"统一"改掉；app 的 `styles.css` 只许 400 / 600。
- **字号阶梯（app）**：只许 `12 / 13 / 14 / 15 / 17 / 20 / 22 / 26 / 30`（px）。
- **字号阶梯（门面）**：只许 `14 / 15 / 16 / 17 / 20` + 三个 clamp。
- **图标**：全站 `strokeWidth` 只许 `1.5`。
- **提交前必过**：`npm test` + `npm run typecheck` 两个都要绿。批 2/3 另加 `npm run check:layout`（真 Chrome，量照片尺寸——间距改动会动到它的数字）。
- **验收基准**：`.superpowers/brainstorm/11274-1791362894/content/`（画板三轮素材）+ `.superpowers/scratch/audit/board-shots-{1,2,3}.mjs` 里注入的样式段（精确值原件）。
- 后端不热重载与本次无关；dev 服务器（5173）开着即可。

---

### Task 1: 字号收编 + 字重 + 等宽（含"尺子守卫"测试）

**Files:**
- Create: `src/styles.ruler.test.ts`
- Modify: `src/styles.css`（16 处，逐条见 Step 3）

**Interfaces:**
- Produces: `src/styles.ruler.test.ts` —— 常驻守卫。Task 2/3 会往同一个文件里加断言（图标线宽、门面阶梯），文件名与读取方式（`new URL('./styles.css', import.meta.url)`）在本任务定死。

- [x] **Step 1: 写守卫测试（此刻应当全红）**

```ts
// src/styles.ruler.test.ts
/**
 * 表现层「尺子」的常驻守卫（★ 2026-10-07「完成度升级」，spec §2/§3）。
 *
 * 圆角、字号、字重、图标线宽这几样**没有任何测试量得到**（jsdom 不算样式，
 * check:layout 只量盒子）——这批守卫用字符串哨兵读 CSS/TSX 源文件，
 * 把"尺子"钉在源码层。仓库先例：CompareSplit.test.tsx 读 styles.css。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const landing = readFileSync(new URL('./landing.css', import.meta.url), 'utf8')

const APP_SIZES = new Set(['12', '13', '14', '15', '17', '20', '22', '26', '30'])
const LANDING_SIZES = new Set(['14', '15', '16', '17', '20'])

describe('尺子守卫 · 字号', () => {
  it('app 的 font-size 只许 9 档', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1])
    const bad = [...new Set(sizes.filter((s) => !APP_SIZES.has(s)))]
    expect(bad, `styles.css 里出现了阶梯外字号: ${bad.join(', ')}`).toEqual([])
  })
  it('门面的 font-size 只许 5 档', () => {
    const sizes = [...landing.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1])
    const bad = [...new Set(sizes.filter((s) => !LANDING_SIZES.has(s)))]
    expect(bad, `landing.css 里出现了阶梯外字号: ${bad.join(', ')}`).toEqual([])
  })
})

describe('尺子守卫 · 字重', () => {
  it('app 只许 400 / 600', () => {
    const ws = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1])
    const bad = [...new Set(ws.filter((w) => w !== '400' && w !== '600'))]
    expect(bad, `styles.css 里出现了第三档字重: ${bad.join(', ')}`).toEqual([])
  })
})

describe('尺子守卫 · 图标线宽', () => {
  it('src/ui 下所有 strokeWidth 只许 1.5', () => {
    const bad: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/strokeWidth=\{?([\d.]+)\}?/g)) {
          if (m[1] !== '1.5') bad.push(`${name}: strokeWidth=${m[1]}`)
        }
      }
    }
    walk(resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'ui'))
    expect(bad, `线宽不统一: ${bad.join(' / ')}`).toEqual([])
  })
})
```

> ⚠️ 最后那段 `walk` 的路径换算在 Windows 上要稳：实现者若发现 `new URL('.', import.meta.url).pathname` 带前导斜杠的问题，改用 `fileURLToPath(new URL('./ui', import.meta.url))`（从 `node:url` 导入）——**以能在这个仓库跑绿为准**，两种写法任选其一。

- [x] **Step 2: 跑它，确认红（这就是"现状清单"的机器版）**

Run: `npx vitest run src/styles.ruler.test.ts`
Expected: FAIL —— 会报出 `12.5, 13.5, 14.5, 18`（字号）、`500`（字重）、以及 `strokeWidth=2 / 1.7` 几处。把这些**当作清单核对一遍**再往下。

- [x] **Step 3: 改 `src/styles.css`（逐条 before→after）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.bubble` | `font-size: 13.5px` | `font-size: 14px` |
| 2 | `.composer-text` | `font-size: 14.5px` | `font-size: 14px` |
| 3 | `.rename-input` | `font-size: 18px` | `font-size: 17px` |
| 4 | `.composer-nag` | `font-size: 12.5px` | `font-size: 12px` |
| 5 | `.presets-works-note` | `font-size: 12.5px` | `font-size: 12px` |
| 6 | `.msg-menu button` | `font-size: 12.5px` | `font-size: 12px` |
| 7 | `.msg-confirm` | `font-size: 12.5px` | `font-size: 12px` |
| 8 | `.cards-now` | `font-size: 12.5px` | `font-size: 12px` |
| 9 | `.cards-note` | `font-size: 12.5px` | `font-size: 12px` |
| 10 | `.chat-select-note` | `font-size: 12.5px` | `font-size: 12px` |
| 11 | `.gallery-end, .sessions-end` | `font-size: 12.5px` | `font-size: 12px` |
| 12 | `.session-menu button` | `font-size: 12.5px` | `font-size: 12px` |
| 13 | `.sessions-select-note` | `font-size: 12.5px` | `font-size: 12px` |
| 14 | `.session-ask` | `font-size: 12.5px` | `font-size: 12px` |
| 15 | `.recipe-note` | `font-size: 12.5px` | `font-size: 12px` |
| 16 | `.gallery-day-title` | `font-weight: 500` | `font-weight: 400` |

再加两条：

```css
/* .session-steps —— 「N 步」是会变的数字，补等宽 */
.session-steps { flex: none; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
```

把顶部令牌区那条注释里的「12.5px 的小字」改成「12px 的小字」（`grep -n "12\.5" src/styles.css` 收尾核一遍，注释里不许再留旧档位）。

- [x] **Step 4: 跑守卫 —— 字号/字重两节转绿**（图标那节仍红，那是 Task 2）

Run: `npx vitest run src/styles.ruler.test.ts`
Expected: 字号、字重两组 PASS；图标组 FAIL（还剩 strokeWidth 未改）。

- [x] **Step 5: 真机扫一眼**（字号合并最怕把哪处挤破）

```bash
node .superpowers/scratch/audit/shoturl.mjs http://127.0.0.1:5173/ .superpowers/scratch/audit/ruler-lp.png 3000
```
再开 `http://localhost:5173/app`（登录状态）顺手翻：调色屏 / 对话 / 作品 / 会话列表 / 设置三页，看有没有哪里换行变丑。

- [x] **Step 6: 全套绿 + 提交**

Run: `npm test` 和 `npm run typecheck`
Expected: 前者除新守卫外全绿；守卫此时允许图标组仍红——**这一条是本任务唯一允许的"半红"，Task 2 收口**。提交：

```bash
git add src/styles.css src/styles.ruler.test.ts
git commit -m "polish(尺子): 字号收 9 档 + 字重两档 + 数字等宽 —— 四个半档(12.5/13.5/14.5/18)退役,带常驻守卫"
```

---

### Task 2: 图标线宽统一 1.5

**Files:**
- Modify: `src/ui/ChatPanel.tsx`（Plus）
- Modify: `src/ui/LoginPage.tsx`（Eye / EyeOff）
- Modify: `src/ui/CompareSplit.tsx`（ChevronsLeftRight）
- Modify: `src/ui/LandingPage.tsx`（ArrowUp）
- Test: `src/styles.ruler.test.ts`（Task 1 已写，本任务只负责转绿）

**Interfaces:**
- Consumes: Task 1 的守卫文件与 `strokeWidth` 断言。

- [x] **Step 1: 确认守卫红在哪**

Run: `npx vitest run src/styles.ruler.test.ts`
Expected: FAIL 列出 `strokeWidth=2`（ChatPanel）/ `1.7`（LoginPage）/ 无显式值的（CompareSplit、LandingPage 用默认 2，替换后用显式 1.5）。

- [x] **Step 2: 四处改（只加/改这一个属性，别动尺寸）**

| 文件 | 现在 | 改成 |
|---|---|---|
| `ChatPanel.tsx` | `<Plus size={16} strokeWidth={2} aria-hidden="true" />` | `strokeWidth={1.5}` |
| `LoginPage.tsx` | `strokeWidth={1.7}`（Eye 与 EyeOff 各一处） | `strokeWidth={1.5}` |
| `CompareSplit.tsx` | `<ChevronsLeftRight size={15} />` | `<ChevronsLeftRight size={15} strokeWidth={1.5} aria-hidden="true" />` |
| `LandingPage.tsx` | `<ArrowUp size={18} aria-hidden="true" />` | 补 `strokeWidth={1.5}` |

- [x] **Step 3: 守卫全绿**

Run: `npx vitest run src/styles.ruler.test.ts`
Expected: PASS（三组全绿）。

- [x] **Step 4: 真机看一眼**（图标最怕肉眼才看得出"细了没"）

截一张调色屏（`board-shots-1.mjs` 同款方法）与登录页，和 `now-full.png` 对一眼。

- [x] **Step 5: 全套绿 + 提交**

Run: `npm test` 和 `npm run typecheck`
Expected: 全绿。

```bash
git add src/ui/ChatPanel.tsx src/ui/LoginPage.tsx src/ui/CompareSplit.tsx src/ui/LandingPage.tsx
git commit -m "polish(尺子): 图标线宽统一 1.5 —— 2 / 1.7 / 默认 三档归位,守卫收口"
```

---

### Task 3: 门面字号归位 + 圆角收编

**Files:**
- Modify: `src/landing.css`（5 处）
- Test: `src/styles.ruler.test.ts`（门面断言已在 Task 1 写；本任务转绿）

- [x] **Step 1: 确认门面守卫红**

Run: `npx vitest run src/styles.ruler.test.ts`
Expected: FAIL —— `landing.css 里出现了阶梯外字号: 15.5, 17.5`。

- [x] **Step 2: 改 `src/landing.css`（逐条）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.lp-btn` | `font-size: 15.5px` | `font-size: 16px` |
| 2 | `.lp-cell p` | `font-size: 15.5px` | `font-size: 16px` |
| 3 | `.lp-brand` | `font-size: 15.5px` | `font-size: 16px` |
| 4 | `.lp-lede` | `font-size: 17.5px` | `font-size: 17px` |
| 5 | `.lp-rail img` | `border-radius: 10px` | `border-radius: 12px` |

（门面的 380 / 500 / 600 字重**不动**——Global Constraints。）

- [x] **Step 3: 守卫全绿 + 门面真机图**

Run: `npx vitest run src/styles.ruler.test.ts` → PASS
再按 `board-shots-3.mjs` 的拍法出一张浅色整页，和 `_lp-after-full.png` 对（差异应只在这 5 处）。

- [x] **Step 4: 全套绿 + 提交**

Run: `npm test` 和 `npm run typecheck`

```bash
git add src/landing.css
git commit -m "polish(尺子): 门面字号归位(15.5→16 / 17.5→17) + 照片带圆角 10→12"
```

---

### Task 4: 节奏尺子 · 调色屏（面板 / 工具行 / 预设栏）

**Files:**
- Modify: `src/styles.css`（下述 8 条）
- 基准：`board-shots-1.mjs` 的 `V_B` 段 + `content/vb-crop.png`

- [x] **Step 1: 改 `src/styles.css`（before→after 逐条）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.panel` | `padding: 0 var(--sp-5) var(--sp-5)` | `padding: 0 28px 28px` |
| 2 | `.panel-head` | `margin-top: var(--sp-4); margin-bottom: var(--sp-2)` | `margin-top: 20px; margin-bottom: 12px` |
| 3 | `.panel-group + .panel-group` | `margin-top: var(--sp-4); padding-top: var(--sp-3)` | `margin-top: 24px; padding-top: 16px` |
| 4 | `.panel-group-head` | `padding: 5px 0 4px` | `padding: 7px 0 6px` |
| 5 | `.slider` | `margin: 5px 0` | `margin: 8px 0` |
| 6 | `.presets-ref` | `margin-bottom: var(--sp-4)` | `margin-bottom: 20px` |
| 7 | `.tool-row-main` | `padding: var(--sp-2) var(--sp-3)` | `padding: 10px 14px` |
| 8 | `.tool-cell` | `padding: 5px 12px` | `padding: 6px 14px` |
| 9 | `.rail` | `padding: var(--sp-3) 10px var(--sp-4)` | `padding: 16px 12px 20px` |
| 10 | `.rail-head` | `margin: 0 0 var(--sp-3)` | `margin: 0 0 16px` |
| 11 | `.rail-grid` | `gap: var(--sp-3) var(--sp-2)` | `gap: 16px 10px` |

- [x] **Step 2: `check:layout`（间距会动到它量的数字）**

Run: `npm run check:layout`
Expected: 全绿。若红，看是不是照片尺寸被挤破——数值有富余，红了就**停下报数**，别硬调判据。

- [x] **Step 3: 真机对照基准**

用 `board-shots-1.mjs` 重拍 `now` 的同款截图（把 `addStyleTag` 那段删掉、直接拍），和 `content/vb-full.png`、`vb-crop.png` 对照：**逐块对齐，差异只允许来自"现在 vs 注入版"的同一批值**。

- [x] **Step 4: 全套绿 + 提交**

Run: `npm test` 和 `npm run typecheck`

```bash
git add src/styles.css
git commit -m "polish(节奏): 调色屏呼吸一档 —— 面板/工具行/预设栏照画板 B 版落值"
```

---

### Task 5: 节奏尺子 · 对话屏

**Files:**
- Modify: `src/styles.css`（6 条）
- 基准：`board-shots-2.mjs` 的 `B` 段 + `content/r2chat.png`

- [x] **Step 1: 改（before→after）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.chat-log` | `padding: var(--sp-4); gap: var(--sp-3)` | `padding: 20px; gap: 16px` |
| 2 | `.bubble` | `padding: 9px 13px` | `padding: 11px 15px` |
| 3 | `.chat-input` | `padding: var(--sp-3) var(--sp-4)` | `padding: 14px 18px` |
| 4 | `.chat-tools` | `padding: var(--sp-3) var(--sp-4) 0` | `padding: 14px 18px 0` |
| 5 | `.chat-lut` | `padding: var(--sp-3) var(--sp-4) 0` | `padding: 14px 18px 0` |
| 6 | `.chat-select` | `padding: var(--sp-3) var(--sp-4)` | `padding: 14px 18px` |

- [x] **Step 2: 真机对照 `r2chat.png`**（左=现在基线、右=注入版；改完的应等于右半）。

- [x] **Step 3: `check:layout` + 全套绿 + 提交**

Run: `npm run check:layout` → 绿；`npm test` / `npm run typecheck` → 绿。

```bash
git add src/styles.css
git commit -m "polish(节奏): 对话屏呼吸一档 —— 气泡/输入行/工具行照画板 B 版落值"
```

---

### Task 6: 节奏尺子 · 作品页 + 会话列表

**Files:**
- Modify: `src/styles.css`（8 条）
- 基准：`content/r2gal.png`、`content/r2ses.png`

- [x] **Step 1: 改（before→after）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.gallery-head` | `padding: 16px 0 12px` | `padding: 18px 0 14px` |
| 2 | `.gallery-day` | `margin-top: var(--sp-5)` | `margin-top: 32px` |
| 3 | `.gallery-day-title` | `margin: 0 0 var(--sp-3)` | `margin: 0 0 14px` |
| 4 | `.gallery-grid` | `gap: var(--sp-3)` | `gap: 16px` |
| 5 | `.gallery-name` | `margin-top: var(--sp-2)` | `margin-top: 10px` |
| 6 | `.sessions` | `padding: var(--sp-4) var(--sp-5) var(--sp-5)` | `padding: 20px 28px 28px` |
| 7 | `.sessions-day` | `margin-top: var(--sp-5)` | `margin-top: 32px` |
| 8 | `.session-row` | `margin-bottom: var(--sp-2)` | `margin-bottom: 12px` |
| 9 | `.session-open` | `padding: var(--sp-2) var(--sp-3)` | `padding: 10px 14px` |

- [x] **Step 2: 真机对照 `r2gal.png` / `r2ses.png`**（改完 = 右半）。

- [x] **Step 3: `check:layout` + 全套绿 + 提交**

Run: `npm run check:layout` → 绿；`npm test` / `npm run typecheck` → 绿。

```bash
git add src/styles.css
git commit -m "polish(节奏): 作品页与会话列表呼吸一档 —— 照画板 B 版落值"
```

---

### Task 7: 节奏尺子 · 设置三页 + 详情页（同一把尺子往后铺）

**Files:**
- Modify: `src/styles.css`（7 条）

> 这张表没有画板基准图（三轮没覆盖这几屏）——按 spec §1 的**同一类关系同一个值**推的，判据是"和已定的那几屏站在一起不突兀"。真机截图自查 + `check:layout`。

- [x] **Step 1: 改（before→after）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.account-grid` | `gap: var(--sp-5)` | `gap: 28px` |
| 2 | `.account-tile` | `gap: var(--sp-3)` | `gap: 16px` |
| 3 | `.account-row` | `padding: var(--sp-3) var(--sp-4)` | `padding: 14px 18px` |
| 4 | `.models-row` | `padding: var(--sp-2) 0` | `padding: 10px 0` |
| 5 | `.detail-head` | `padding: var(--sp-4) 0 var(--sp-3)` | `padding: 18px 0 14px` |
| 6 | `.detail-actions` | `margin-top: var(--sp-4)` | `margin-top: 20px` |
| 7 | `.recipe-params li` | `padding: 6px 0` | `padding: 8px 0` |

- [x] **Step 2: 真机翻四屏**：个人设置 / 模型设置 / Lut / 作品详情。

- [x] **Step 3: `check:layout` + 全套绿 + 提交**

```bash
git add src/styles.css
git commit -m "polish(节奏): 设置三页与详情页吃同一把尺子"
```

---

### Task 8: 窄屏复验（≤640）

**Files:**
- Modify: `src/styles.css`（窄屏媒体查询内 1 条）

- [x] **Step 1: 窄屏面板左右收一档**（28px 在 390px 手机上太宽）

在 `@media (max-width: 640px)` 块里加：

```css
  /* 呼吸一档在窄屏收回来一点：面板在手机上左右 20px 就够（28 会挤掉内容宽度） */
  .panel { padding-left: 20px; padding-right: 20px; }
```

- [x] **Step 2: `check:layout`（它量的就是窄屏）**

Run: `npm run check:layout`
Expected: 全绿（照片尺寸判据有富余；红了停下报数）。

- [x] **Step 3: 手机宽度真机扫**（390×844）：修图屏 / 调色屏 / 会话列表 / 作品页各一张，看心跳/挤压。

- [x] **Step 4: 全套绿 + 提交**

```bash
git add src/styles.css
git commit -m "polish(节奏): 窄屏面板左右收一档 —— 呼吸在手机上不挤内容"
```

---

### Task 9: 门面七处节奏

**Files:**
- Modify: `src/landing.css`（7 条）
- 基准：`board-shots-3.mjs` 的 `LP` 段 + `content/_lp-after-full.png`（浅）/`_lp-after-full-dark.png`（深）

- [x] **Step 1: 改（before→after）**

| # | 选择器 | 现在 | 改成 |
|---|--------|------|------|
| 1 | `.lp-prod` | `margin: 76px auto 0` | `margin: 72px auto 0` |
| 2 | `.lp-ba` | `margin-top: 64px` | `margin-top: 72px` |
| 3 | `.lp-bento` | `margin-top: 76px` | `margin-top: 72px` |
| 4 | `.lp-final .lp-btn` | `margin-top: 40px` | `margin-top: 48px` |
| 5 | `.lp-cell` | `padding: 46px 46px 50px` | `padding: 50px 50px 54px` |
| 6 | `.lp-cell.lp-photo .lp-cap` | `padding: 34px 46px 42px` | `padding: 36px 50px 44px` |
| 7 | `.lp-ba-legend` | `gap: 44px; margin-top: 32px` | `gap: 48px; margin-top: 36px` |
| 8 | `.lp-footer .lp-wrap` | `padding-top: 36px; padding-bottom: 42px` | `padding-top: 40px; padding-bottom: 48px` |

⚠️ 注意 `.lp-prod` 的 `padding-bottom`（浮层那笔账）**不要动**——那是 10-07 刚校准的浮层 reserve，改它会把浮层顶上去盖住对话栏。

- [x] **Step 2: 浅 + 深两种模式各拍整页**（照 `board-shots-3.mjs` 的拍法，去掉注入那步），和 `_lp-after-full.png` / `_lp-after-full-dark.png` 对照。

- [x] **Step 3: 全套绿 + 提交**

```bash
git add src/landing.css
git commit -m "polish(节奏): 门面七处 —— 标题间距统一 72 / 卡片呼吸 50 / 七处归位"
```

---

## 收尾（全部完成后）

- 跑一遍 `npm run check:copy`（文案没动，跑它是为了确认没被样式改动波及的选择器腐烂）。
- 按 spec §5 把四批的真机截图与画板三轮基准摆在一起核对一次，**任何基准外的视觉变化都要解释**。
- 更新「设计文档」§6 状态或在提交信息里记全。

## Self-Review（写完自查过）

- **Spec coverage**：spec §1 节奏 → Task 4-9；§2 字号 → Task 1/3；§3 六条微修 → Task 1（字数/字重/等宽）、Task 2（图标）、Task 3（门面字号/圆角）、Task 9（节奏写入）；§4 不做清单 → Global Constraints 全文；§5 验收基准 → 每个任务的"对照基准"步。无缺口。
- **Placeholder scan**：无 TBD/TODO；每处改动的 before/after 都写死；唯一留白是 Task 1 Step 1 里 `walk()` 的路径写法（给了两种，以跑绿为准）——这是环境差异，不是占位。
- **Type consistency**：本计划无新函数/接口；唯一新文件 `src/styles.ruler.test.ts` 的名字在 Task 1/2/3 中一致。
- **一个已知张力**：Task 1 结束时守卫的图标组允许仍红（Task 2 收口）——已在 Step 6 明说，不是漏洞。

---

## 完成记录（2026-10-07 夜）

九任务四批全部完成，逐批验收：

- 批1 字号/微修：`640cf6e`（app+守卫）· `13be0b4`（门面字号圆角）
- 批2 节奏四屏：`5bfff90`(调色) · `bc27f42`(对话) · `31f66a3`(作品+会话) —— 四屏与画板基准逐像素 0.00/255
- 批3 设置/详情/窄屏：`ffcbd0f`（check:layout 两档全绿）
- 批4 门面七处：本轮提交 —— 浅/深整页 0.00/255，check:copy 绿
- 每批均过 npm test + npm run typecheck；批2/3 另跑 check:layout 全绿。
- 与计划的两处小偏差：① 批1 因「提交前必须全绿」把三个任务的提交并成两笔；
  ② check:layout 按"每批一次"跑（覆盖面相同，见各提交信息）。
