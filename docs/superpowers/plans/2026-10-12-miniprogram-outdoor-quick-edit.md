# 小程序「户外快速修图」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个微信原生小程序：选照片 → 挑风格/说一句 → 按住对比 → 存相册（户外快速修图）。

**Architecture:** 新建 `mini/`（微信原生 + TypeScript）与电脑版并排。修图渲染（手写 WebGL2 管线）移植进小程序本地跑；「说一句」走现有后端（`/api/route` + `/api/edit`），身份用静默微信登录（新增 `/api/wx-login`）。电脑版只做两处小改：抽 `uniforms.ts`、会话支持 `Authorization: Bearer`，其余一律不动。

**Tech Stack:** 微信原生小程序（WXML/WXSS/TS）、WebGL2、miniprogram-automator（冒烟）、vitest（电脑版仓库，覆盖共享逻辑与后端）、Node 原生 http（mock 后端）。

**Spec:** `docs/superpowers/specs/2026-10-12-miniprogram-outdoor-quick-edit-design.md`（每个任务先读它相关小节；本计划与它冲突时以 spec 为准并当场更正计划）。

## Global Constraints（每个任务都隐含遵守）

- **文案**：任何界面文案以 `docs/文案规范.md` 为准（实现时逐条核）；叫「保存」（不是「存进作品」）。
- **两个绿**：电脑版仓库改动收尾必须 `npm test` + `npm run typecheck` 双绿（改到 `src/render/` 的 GLSL 或管线再加 `npm run check:lut`）。
- **真机为准**：模拟器跑在电脑显卡上（实测 RENDERER 不同），关键结论（画得动、颜色对、内存）只认真机。⚠️ 真机步骤需要用户扫码参与。
- **红线**：`.env`（钥匙，只追加不查看）、`data/`（用户数据）、电脑版 `package.json`/`vite.config.ts`/`tsconfig*.json`/`index.html` 不动。AppSecret 只进 `.env`，不进代码、不进日志、不进提交。
- **提交**：干完就提交（用户要求自动提交）；**别 `git add -A`**，逐任务 add 自己碰的文件。
- **API 钥匙**：小程序永远不直连商汤/Agnes，一切 AI 走自家后端（客户端不持钥匙）。
- **小程序 API 以官方文档为准**：涉及 wx.* 的调用，动手时对照 developers.weixin.qq.com 现文档（训练数据会滞后）；本计划里的调用写法来自 2026-09 真机探针（`archive/spike/miniprogram-webgl/`），是可信基线。

## 预备知识（执行者必读）

### 微信开发者工具（本机已装 `D:\微信web开发者工具\`）

CLI 起项目（**用 PowerShell**，Git Bash 直接调中文路径会被编码搞坏）：

```powershell
$d = (Get-ChildItem 'D:\' -Directory | Where-Object { $_.Name -match '开发者工具' }).FullName
& (Join-Path $d 'cli.bat') auto --project 'D:\RuiXing\mini' --auto-port 9420 --trust-project
```

前置：工具 → 设置 → 安全设置 → **服务端口打开**（不开 CLI 用不了）。工具 CLI 的 `auto` 会常驻，配合 automator 连 `ws://127.0.0.1:9420`。

### 探针里验证过的三件事（别重新踩）

1. **拿 canvas 节点**：`wx.createSelectorQuery().select('#gl').fields({ node: true, size: true })` —— **必须接住链式方法的返回值再 `exec`**（探针为此报过"三个画布全拿不到节点"）。
2. **图片进纹理**：`node.createImage()` → onload → 画进 `wx.createOffscreenCanvas({type:'2d',width,height})` → `texImage2D` 传**那个 2D 画布**（直接传 image 对象报 1281）。
3. **automator 两个坑**：Windows 上 `automator.launch()` 起不了 .bat（在外面用 PowerShell 起好 CLI 再 `connect()`）；`page.callMethod()` 会等异步方法跑完而超时（改成**点按钮 + 轮询页面 data**）。

### 待验的未知（任务 5 现场解决）

- **1281 之谜**：探针里 1536×2048 的离屏 2D 画布上传报 1281、1152×1536 就过（上限明明 16384）。
- `texImage3D`（LUT 的 3D 纹理占位）小程序支持性未验 —— 不支持就摘掉 LUT 分支（第一版不用 LUT，`setLut(null)` 路径）。

### 深色设计令牌（从 `src/styles.css` 抄的深色那半，保持同名）

```
--bg       #151517        --accent-300 #5eead4
--panel    #1e1e21        --accent-400 #2dd4bf   （主色）
--raised   #26262a        --accent-500 #5eead4
--hover    #323238        --accent-700 #0f766e
--line     #33333a        --accent-ink #042f2e
--line-2   #43434c        --accent-tint #123330
--line-3   #56565f        --photo-edge rgba(255,255,255,.22)
```

圆角：小元件 10rpx 级、胶囊 999rpx；间距节奏同电脑版（面板内 28 → rpx 换算见任务 1）。

---

## 文件结构（建完之后长这样）

```
mini/                              ← 新目录，全部新增（除注明"改"的）
├── project.config.json            工程配置（appid、urlCheck:false）
├── tsconfig.json                  给 npx tsc -p mini 用
├── app.json / app.ts / app.wxss   全局（深色、custom 导航）
├── types/wx.d.ts 等               从 miniprogram-api-typings 拷来的类型
├── lib/
│   ├── config.ts                  API 基地址（唯一可配置处）
│   ├── shared/                    ☆ 同步来的（自动生成，勿改）
│   │   ├── adjustments.ts  size.ts  presets.ts  shader.ts  uniforms.ts  lut.ts
│   ├── gl/tonePipeline.ts         小程序版渲染管线（平台三件事：拿 canvas/上传/导出）
│   ├── image/thumbs.ts            sprite 缩略图渲染
│   ├── image/prepare.ts           缩图给模型（640 路由图 / 2048 编辑图，JPEG dataURL）
│   ├── api.ts                     HTTP 客户端（Bearer、401 重登一次）
│   └── auth.ts                    静默登录（wx.login → token 存 storage）
├── pages/index/                   唯一的页面：空态 / 编辑态 / 生成中
│   ├── index.wxml index.wxss index.ts index.json
├── pages/dev/                     仅开发版：加载测试图通道（冒烟用）
└── scripts/
    ├── smoke.cjs                  automator 冒烟（含全黑哨兵）
    └── mock-server.cjs            mock 后端（route/edit，不花钱）

电脑版（改，共四处）：
├── src/render/uniforms.ts         新：从 pipeline.ts 抽出的纯映射（任务 3）
├── src/render/pipeline.ts         改：render() 改用 uniforms（任务 3）
├── server/session.ts 或 app.ts    改：requireUser 认 Authorization: Bearer（任务 10）
├── server/account.ts / db.ts / app.ts  改：微信登录（任务 10）
└── scripts/sync-mini-shared.mjs   新：同步脚本（任务 2）
```

---

### Task 1: 工程骨架 + 空态（开发者工具里跑起来）

**Files:**
- Create: `mini/project.config.json`, `mini/app.json`, `mini/app.ts`, `mini/app.wxss`, `mini/tsconfig.json`, `mini/pages/index/index.{wxml,wxss,ts,json}`, `mini/types/`（拷来的 typing）
- Create: `mini/README.md`（启动方式、API 地址怎么改）

**Interfaces:**
- Consumes: 无
- Produces: 一个能在微信开发者工具里编译、显示空态的单页工程；`app.wxss` 里的深色令牌（后续所有样式用）；页面 data 形状：`{ stage: 'empty' | 'edit', photo: string | null }`。

- [ ] **Step 1: 接入微信开发者工具官方 Skills/MCP**（multi-platform.md 硬要求：不接 agent 就是闭眼改）

照官方文档开启（本机 WebFetch 被策略拦，需在浏览器里看）：
- 开发者工具 Skills：https://developers.weixin.qq.com/miniprogram/dev/devtools/Skills.html
- AI 开发模式（beta）：https://developers.weixin.qq.com/miniprogram/dev/ai/guide.html

在工具的「设置」里开启；若当前工具版本没有这一项，**兜底是已可用且验证过的 CLI + miniprogram-automator 路径**（见「预备知识」），继续往下做，不阻塞。把「最终用上了哪条」记进 `mini/README.md`。

- [ ] **Step 2: 建工程文件**

`mini/project.config.json`（⚠️ appid 用 9 月探针那个号；若用户给了新 AppID 就替换）：

```json
{
  "appid": "wx3222d31da4ec7edb",
  "compileType": "miniprogram",
  "libVersion": "latest",
  "projectname": "pinkrose-mini",
  "setting": {
    "urlCheck": false,
    "es6": true,
    "enhance": true,
    "postcss": false,
    "minified": false
  }
}
```

`mini/app.json`：

```json
{
  "pages": ["pages/index/index"],
  "window": {
    "navigationStyle": "custom",
    "navigationBarTextStyle": "white",
    "backgroundColor": "#151517"
  },
  "sitemapLocation": "sitemap.json"
}
```

（⚠️ `navigationStyle: custom` 决定页面自己画顶栏 —— 「换一张 | PinkRose | 保存」那条。同时新建一个空的 `mini/sitemap.json` 内容 `{"rules":[{"action":"allow","page":"*"}]}`。）

`mini/app.ts`：

```ts
App({})
```

`mini/app.wxss`：把上面「深色设计令牌」整段写成 `page { --bg: #151517; ... }`，并设 `page { background: var(--bg); color: #e8e8ea; font-family: -apple-system, "PingFang SC", sans-serif; }`。

`mini/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "module": "CommonJS",
    "strict": true,
    "noEmit": true,
    "types": [],
    "lib": ["ES2017"],
    "typeRoots": ["./types"]
  },
  "include": ["**/*.ts"]
}
```

`mini/types/`：拷官方 typing（不用构建 npm）：

```bash
cd d:/RuiXing && npm i --no-save miniprogram-api-typings \
  && mkdir -p mini/types && cp node_modules/miniprogram-api-typings/types/*.d.ts mini/types/ \
  && ls mini/types
```

（若包内结构与预期不同，按实际内容拷全部 `.d.ts`；目标是 `npx tsc -p mini` 不报 `Cannot find name 'wx'`。）

- [ ] **Step 3: 空态页面**

`mini/pages/index/index.wxml`（结构；视觉细节照 spec §4.1 和本文档 mock）：

```xml
<view class="page safe-top">
  <view class="topbar" wx:if="{{stage === 'edit'}}">
    <view class="tb-left" bindtap="onPickAgain">换一张</view>
    <view class="tb-title">PinkRose</view>
    <view class="tb-right" bindtap="onSave">保存</view>
  </view>

  <view class="empty" wx:if="{{stage === 'empty'}}">
    <image class="brand-mark" src="/assets/emperor-badge.png" />
    <view class="brand-name">PinkRose</view>
    <view class="empty-sub">拍完随手修，30 秒发出去</view>
    <button class="big-btn" bindtap="onCamera">拍一张</button>
    <button class="big-btn ghost" bindtap="onAlbum">从相册选</button>
  </view>

  <view class="edit" wx:if="{{stage === 'edit'}}">
    <image class="photo" src="{{photo}}" mode="aspectFit" />
  </view>
</view>
```

（`safe-top` 用 `padding-top: env(safe-area-inset-top)` + 状态栏高度：在 `index.ts` 的 `onLoad` 里 `wx.getWindowInfo().statusBarHeight` 存进 data，顶栏 `padding-top` 用它。品牌标 `emperor-badge` 从电脑版 `src/assets/logo/` 拷 PNG 版进 `mini/assets/`——PNG 而不是 SVG，小程序 image 组件对 SVG 支持不完整。）

`index.ts` 骨架：

```ts
Page({
  data: { stage: 'empty', photo: null as string | null, statusBar: 44 },
  onLoad() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: info.statusBarHeight ?? 44 })
  },
  onCamera() {},   // 任务 4
  onAlbum() {},    // 任务 4
  onPickAgain() {},// 任务 4
  onSave() {},     // 任务 9
})
```

- [ ] **Step 4: 编译验证**

```bash
cd d:/RuiXing && npx tsc -p mini --noEmit
```

Expected: 无输出（类型过）。然后起 CLI（见预备知识）在模拟器里看：**空态显示**（标、名字、两颗按钮、深色底）。截图存 `.superpowers/mini/`（目录你建）。

- [ ] **Step 5: 提交**

```bash
git add mini/ && git commit -m "feat(小程序): 工程骨架 + 空态（custom 深色导航）"
```

---

### Task 2: 同步脚本（共享文件的唯一真相源）

**Files:**
- Create: `scripts/sync-mini-shared.mjs`
- Test: `src/tools/syncMiniShared.test.ts`（测试从 src 引脚本 —— 不必改 vitest include）
- Produces: `mini/lib/shared/{adjustments,lut,presets,shader,uniforms,size}.ts`（自动生成）

**Interfaces:**
- Consumes: `shared/adjustments.ts`、`shared/lut.ts`、`shared/size.ts`、`src/core/presets.ts`、`src/render/shader.ts`、`src/render/uniforms.ts`（任务 3 产物 —— 本任务先按名字登记，Task 3 完成后重跑即可）
- Produces: `rewriteImports(source, knownFiles): string`（供测试）、CLI `node scripts/sync-mini-shared.mjs [--check]`

- [ ] **Step 1: 写失败测试** `src/tools/syncMiniShared.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { rewriteImports } from '../../scripts/sync-mini-shared.mjs'

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tools/syncMiniShared.test.ts`
Expected: FAIL（`sync-mini-shared.mjs` 不存在 / 没有导出）

- [ ] **Step 3: 实现** `scripts/sync-mini-shared.mjs`

```js
#!/usr/bin/env node
// 把电脑版里的「单一真相源」文件同步进 mini/lib/shared/。
// ⚠️ 这些文件是小程序的**生成物**，别在 mini 里改它们 —— 改源头，重跑本脚本。
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
  if (checkOnly) {
    if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
    console.log('✓ 镜像与源头一致')
  }
}

if (process.argv[1] && process.argv[1].endsWith('sync-mini-shared.mjs')) {
  syncFiles(process.argv.includes('--check'))
}
```

- [ ] **Step 4: 跑测试确认通过 + 真跑一次**

Run: `npx vitest run src/tools/syncMiniShared.test.ts && node scripts/sync-mini-shared.mjs`
Expected: 测试 3 条绿；脚本输出 5 个 ✓（`uniforms.ts` 还没建时先跳过它 —— 把这行从 FILES 临时注释掉，或先做 Task 3 再做本步；**推荐先做 Task 3**）。

- [ ] **Step 5: 提交**

```bash
git add scripts/sync-mini-shared.mjs src/tools/syncMiniShared.test.ts mini/lib/shared/
git commit -m "feat(小程序): 共享文件同步脚本（唯一真相源 + --check 守卫）"
```

---

### Task 3: 抽出 `uniforms.ts`（电脑版，TDD）

**Files:**
- Create: `src/render/uniforms.ts`
- Modify: `src/render/pipeline.ts`（`render()` 里那段 map 搬走）
- Test: `src/render/uniforms.test.ts`

**Interfaces:**
- Consumes: `shared/adjustments.ts` 的 `toUnit`
- Produces: `UNIFORM_NAMES`（15 个 uniform 名字的数组）与 `uniformValues(a: Adjustments): Record<UniformName, number>`（返回**已 toUnit** 的值）。小程序版管线和 web 版都调它。

- [ ] **Step 1: 写失败测试** `src/render/uniforms.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { UNIFORM_NAMES, uniformValues } from './uniforms'
import { ZERO } from '../../shared/adjustments'

describe('uniformValues', () => {
  it('15 个名字一个不少', () => {
    expect(UNIFORM_NAMES).toHaveLength(15)
    expect(new Set(UNIFORM_NAMES).size).toBe(15)
  })
  it('全零参数映射全零', () => {
    const v = uniformValues(ZERO)
    for (const n of UNIFORM_NAMES) expect(v[n]).toBe(0)
  })
  it('100 映射到 1（toUnit 在函数内做过）', () => {
    const v = uniformValues({ ...ZERO, exposure: 100 })
    expect(v.uExposure).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/render/uniforms.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（把 `pipeline.ts` 里 `UNIFORM_NAMES` 与 `render()` 内的 map 整体搬来）

```ts
import { toUnit, type Adjustments } from '../../shared/adjustments.ts'

export const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
  'uVibrance', 'uCbCyanRed', 'uCbMagentaGreen', 'uCbYellowBlue',
  'uSplitHiHue', 'uSplitLoHue', 'uSplitAmount',
] as const

export type UniformName = typeof UNIFORM_NAMES[number]

/** 入参是 [-100,100] 原始参数；返回 [-1,1] 的 uniform 值（toUnit 只在这里调一次）。 */
export function uniformValues(a: Adjustments): Record<UniformName, number> {
  const u = toUnit(a)
  return {
    uExposure: u.exposure, uContrast: u.contrast, uHighlights: u.highlights,
    uShadows: u.shadows, uSaturation: u.saturation, uTemperature: u.temperature,
    uClarity: u.clarity, uVignette: u.vignette, uVibrance: u.vibrance,
    uCbCyanRed: u.cbCyanRed, uCbMagentaGreen: u.cbMagentaGreen, uCbYellowBlue: u.cbYellowBlue,
    uSplitHiHue: u.splitHiHue, uSplitLoHue: u.splitLoHue, uSplitAmount: u.splitAmount,
  }
}
```

`pipeline.ts` 改动：删本地 `UNIFORM_NAMES`/`UniformName` 定义，改从 `./uniforms` import；`render()` 里 `const map = {...}` 整段删掉、循环改用 `uniformValues(a)`。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run typecheck`
Expected: 双绿（pipeline 现有测试覆盖 render 行为，映射搬家不改行为）。

- [ ] **Step 5: 提交 + 重跑同步**

```bash
git add src/render/uniforms.ts src/render/uniforms.test.ts src/render/pipeline.ts
git commit -m "refactor(render): uniform 映射抽成 uniforms.ts（web/小程序共用一份）"
node scripts/sync-mini-shared.mjs
```

（第二个提交在任务 2 已建目录的情况下：`git add mini/lib/shared/ && git commit -m "chore(小程序): 同步共享文件"`）

---

### Task 4: 选照片 → 编辑态（先不渲染）

**Files:**
- Modify: `mini/pages/index/index.ts`（`onCamera` / `onAlbum` / `onPickAgain`）、`index.wxml`（编辑态分支已留位）

**Interfaces:**
- Consumes: Task 1 的页面骨架
- Produces: `pickPhoto(source: 'camera' | 'album'): Promise<string>`（返回 tempFilePath）；data 里 `photo` / `photoW` / `photoH`（后续任务用）；`stage: 'edit'`。

- [ ] **Step 1: 实现选照片**（探针验证过的调用）

```ts
async function pickPhoto(sourceType: 'camera' | 'album') {
  const res = await wx.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sizeType: ['original'],
    sourceType: [sourceType],
  })
  return res.tempFiles[0].tempFilePath
}

// Page 里：
async onCamera() { await this.loadFrom('camera') },
async onAlbum() { await this.loadFrom('album') },
async loadFrom(source: 'camera' | 'album') {
  try {
    const path = await pickPhoto(source)
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>(
      (ok, no) => wx.getImageInfo({ src: path, success: ok, fail: no }))
    this.setData({ stage: 'edit', photo: path, photoW: info.width, photoH: info.height })
  } catch (e) {
    // 用户取消 (errMsg 含 cancel) 不是错，别的才提示
    if (!String((e as { errMsg?: string })?.errMsg).includes('cancel')) {
      wx.showToast({ title: '这张照片打不开，换一张试试', icon: 'none' })
    }
  }
},
onPickAgain() { this.setData({ stage: 'empty', photo: null }) },
```

- [ ] **Step 2: 模拟器验证**

起 CLI → 模拟器里点「从相册选」（模拟器会给个选图对话框）→ 照片以 `<image mode="aspectFit">` 显示、顶栏出现（换一张/PinkRose/保存）。截图。

- [ ] **Step 3: 真机验证（⚠️ 需要用户扫码）**

工具里「预览」→ 用户手机扫码 → 拍照进、相册进、换一张回空态。**这条只是流程验证；渲染在 Task 5。**

- [ ] **Step 4: 提交**

```bash
git add mini/pages/index/
git commit -m "feat(小程序): 选照片（拍照/相册）进编辑态"
```

---

### Task 5: 渲染管线移植（照片真的画出来）

**Files:**
- Create: `mini/lib/gl/tonePipeline.ts`
- Modify: `mini/pages/index/index.ts`（编辑态里放 `<canvas type="webgl2">`，载入照片后渲染）、`index.wxml`

**Interfaces:**
- Consumes: `mini/lib/shared/{shader,uniforms,adjustments,size}.ts`（同步产物）
- Produces: `class TonePipeline`，接口与 web 版**逐字对齐**（好对照）：`setImage(img)`、`setLut(cube|null)`、`resizeToImage()`、`render(a: Adjustments, lutAmount = 0)`、`readPixels()`、`dispose()`；另有小程序特有的静态入口 `TonePipeline.fromCanvasNode(node, onFatal?)`。

- [ ] **Step 1: 写管线（平台三件事的替换）**

结构照抄 `src/render/pipeline.ts` 的骨架（程序编译、VAO/三角形、纹理参数、uniform 循环、drawArrays），三处平台差异：

```ts
// ① 拿上下文：节点来自 pages 层的 selectorQuery（见 Step 2）
const gl = node.getContext('webgl2') as WebGL2RenderingContext | null
if (!gl) throw new Error('这个设备不支持 WebGL2')

// ② 上传图片（探针路径：createImage → 离屏 2D 画布 → texImage2D(canvas)）
//    注意：texImage2D 传**2D 画布**，不是 image 对象（传 image 报 1281）
const off = wx.createOffscreenCanvas({ type: '2d', width: img.width, height: img.height })
off.getContext('2d').drawImage(img, 0, 0)
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off)

// ③ 上下文丢失：小程序没有 'webglcontextlost' 事件 —— 不挂监听（web 版有）
```

**保留**：`preserveDrawingBuffer: true`（导出要读绘图缓冲，web 版同款理由）、`uLut*` uniform 全套（但 `setLut(null)` 时若 `texImage3D` 报错就整体摘掉 LUT 分支 —— **这里就是验 `texImage3D` 的现场**：先跑一次带 1×1×1 白点的构造，看开发者工具控制台报不报错）。

**⚠️ 1281 现场验**：构造完先拿一张 4000×3000 级真照片跑 `texImage2D`。若报 1281：先试「尺寸砍到 2048 长边」，再试「先缩到屏幕尺寸」。**把结论记进 `mini/README.md` 的「已知平台行为」段**（探针的未解之谜在这了结）。

- [ ] **Step 2: 页面接线**

```ts
// index.wxml 编辑态里：
// <canvas type="webgl2" id="stage" class="stage" style="width:{{stageW}}px;height:{{stageH}}px"></canvas>

// index.ts 里（照片到位后）：
const { node } = await new Promise<any>((ok, no) => {
  // ⚠️ 链式返回值必须接住（探针踩过）
  const q = wx.createSelectorQuery().in(this).select('#stage').fields({ node: true, size: true })
  q.exec(res => (res && res[0] && res[0].node) ? ok(res[0]) : no(new Error('拿不到 canvas 节点')))
})
const pipe = TonePipeline.fromCanvasNode(node)
const img = await loadImage(node, this.data.photo)   // node.createImage() + onload
pipe.setImage(img)
pipe.resizeToImage()                                  // 画布 buffer = 照片原尺寸
pipe.render(ZERO)                                     // 无参数先出一张原图
```

画布 CSS 尺寸 = 容器大小；`resizeToImage()` 后画布 buffer 是照片原尺寸、CSS 拉伸显示 —— 和 web 版一致。

- [ ] **Step 3: 模拟器 + 开发者工具控制台验证**

照片出现在编辑区（颜色正常、方向正确 —— V 轴翻转在顶点着色器里已有，若上下颠倒检查那一段有没有照抄）。看控制台有无 GL 报错。

- [ ] **Step 4: 真机验证（⚠️ 需要用户）**

预览 → 手机上看：**大照片（4000×3000 级）能画出来**、颜色对。若有 1281 走本任务 Step 1 的降级分支并记录。

- [ ] **Step 5: 提交**

```bash
git add mini/lib/gl/ mini/pages/index/ mini/README.md
git commit -m "feat(小程序): 移植 WebGL 管线，真照片上屏（含 1281/texImage3D 结论）"
```

---

### Task 6: 风格栏（点一下秒变）

**Files:**
- Create: `mini/lib/image/thumbs.ts`
- Modify: `mini/pages/index/index.{wxml,wxss,ts}`

**Interfaces:**
- Consumes: `TonePipeline`（Task 5）、`mini/lib/shared/presets.ts`（`PRESETS`、`ORIGINAL_ID`）
- Produces: `renderThumbSprite(node, pipe, img, presets): Promise<{ path: string; cells: {id,label,x,w}[] }>` —— 一次性渲染所有预设的缩略图拼成一张 sprite（临时文件路径 + 每格的 x/w）；页面 data 增加 `styles`（格子视图数据）与 `activeStyle`。

- [ ] **Step 1: 实现 thumbs.ts**（主画布临时借用来渲染小图）

```ts
// 每格：画布 buffer 临时 resize 到「照片等比缩到高 128」的尺寸 → render(该预设)
// → readPixels() 读出（⚠️ GL 行序自下而上，putImageData 前**翻行**）
// → 画进离屏 2D 拼图画布 → 全部画完 canvasToTempFilePath 一次导出 sprite。
// 结束把画布 resizeToImage() + render(ZERO) 复位。
// 缩略图只依赖「照片 × 预设」，与当前参数无关 —— 照片载入时渲染这一次即可（契约）。
```

- [ ] **Step 2: 样式栏 UI**

`index.wxml` 编辑态里加：

```xml
<scroll-view class="styles" scroll-x enable-flex="{{true}}">
  <view wx:for="{{styles}}" wx:key="id"
        class="style-cell {{activeStyle === item.id ? 'on' : ''}}"
        data-id="{{item.id}}" bindtap="onStyleTap">
    <view class="style-thumb" style="background-image:url({{spritePath}});background-size:{{spriteSize}};background-position:-{{item.x}}px 0;width:{{item.w}}px"></view>
    <text class="style-name">{{item.label}}</text>
  </view>
</scroll-view>
```

`onStyleTap`：找预设（`ORIGINAL_ID` = 全零）→ `pipe.render(preset.adjustments)` → `setData({ activeStyle })`。**点亮判据 = 全等**（照 `core/presets.ts` 的 `activePresetId` 契约：判全等、原图 = 全零）。

- [ ] **Step 3: 模拟器验证**

点每格 → 画面立刻变、格子点亮跟着走；「原图」→ 回到原样。截图几档对比。

- [ ] **Step 4: 提交**

```bash
git add mini/lib/image/thumbs.ts mini/pages/index/
git commit -m "feat(小程序): 风格栏（sprite 缩略图 + 点选实时套参数）"
```

---

### Task 7: 冒烟脚本 + 全黑哨兵

**Files:**
- Create: `mini/pages/dev/index.{wxml,ts,json}`（仅开发用的「加载测试图」页：把 `test-photos/` 里一张照片拷进 `mini/assets/dev-photo.jpg`，页面直接加载它，绕开系统选图弹窗）、`mini/scripts/smoke.cjs`

**Interfaces:**
- Consumes: Task 6 的页面（`page.data('activeStyle')` 等）、探针的 automator 连接方式
- Produces: `node mini/scripts/smoke.cjs` —— 连模拟器 → 进 dev 页加载测试图 → 切每个风格 → 每档 `readPixels` 数颜色（页面暴露 `__probeColors()` 方法返回 `{ colors: number, first: string }`）→ 断言。

- [ ] **Step 1: 写哨兵断言**（这是本项目最贵的一条教训的移植：**GLSL 编不过 = 每张照片全黑**，而 typecheck/构建/单测四样全瞎）

```
对每一档风格：
  ① colors > 1   —— 不是纯色（纯色 = 全黑/全白的静默失败）
  ② first 各档之间不全相同 —— 相邻两档「原图 vs 黑白」的颜色分布必须不同
  ③ getError() === 0
失败时：保存 screenshot + 打印每一档的 colors/first，退出码 1。
```

- [ ] **Step 2: 写 smoke.cjs**（照 `archive/spike/miniprogram-webgl/run-probe.cjs` 的连接方式：外部 PowerShell 起 CLI、`connect(ws://127.0.0.1:9420)`、**点按钮 + 轮询 data，不要 callMethod 等长任务**；dev 页的探测触发用「点按钮」）。

- [ ] **Step 3: 跑冒烟**

Run: `node mini/scripts/smoke.cjs`
Expected: 每档 print `colors=N first=r,g,b`；全绿退出。故意改坏一下 shader（如 `precision` 行删掉）→ 跑冒烟应当红（**变异检查**：不红说明哨兵是假的）→ 改回。

- [ ] **Step 4: 提交**

```bash
git add mini/pages/dev/ mini/scripts/smoke.cjs mini/app.json
git commit -m "test(小程序): 冒烟 + 全黑哨兵（GLSL 编不过必须能被抓）"
```

---

### Task 8: 按住看原图

**Files:**
- Modify: `mini/pages/index/index.{wxml,ts}`

**Interfaces:**
- Consumes: Task 6 的渲染状态
- Produces: `onPhotoTouchStart/End` —— 按住 **150ms** 起算（电脑版契约）：到点把当前参数换成 ZERO 渲染（画面即原图）；抬起/移动取消 → 渲染回当前参数。**快速点一下不算**（150ms 内抬起什么都不发生）。

- [ ] **Step 1: 实现**（`bindtouchstart` / `bindtouchend` / `bindtouchcancel`，注意 `bindtouchmove` 也取消 —— 拖动是以后的缩放，现在简单取消即可）
- [ ] **Step 2: 模拟器验证**（按住前后画面变化，截图各一张对比）
- [ ] **Step 3: 提交** `git commit -m "feat(小程序): 按住看原图（0.15s 起算）"`

---

### Task 9: 全尺寸导出 → 存相册

**Files:**
- Create: `mini/lib/image/export.ts`
- Modify: `mini/pages/index/index.ts`（`onSave`）

**Interfaces:**
- Consumes: `TonePipeline`、`shared/size` 的 `fitWithin`
- Produces: `exportPhoto(pipe, img, a: Adjustments): Promise<string>`（返回临时文件路径）+ `saveToAlbum(path): Promise<void>`

- [ ] **Step 1: 实现导出**

```ts
// 1) 画布 buffer resize 到全尺寸（照片原尺寸；用 fitWithin 对设备上限兜底 —— 上限读 gl.getParameter(gl.MAX_TEXTURE_SIZE) / MAX_VIEWPORT_DIMS）
// 2) 用当前参数 render
// 3) wx.canvasToTempFilePath({ canvas: node, fileType: 'jpg', quality: 0.92 })
// 4) 返回路径；然后 wx.saveImageToPhotosAlbum({ filePath })
// 5) 授权：首次会弹系统框；被拒过之后走 wx.getSetting 判断 → wx.openSetting 引导
//    （文案要人话，过一遍文案规范）
```

- [ ] **Step 2: 模拟器验证**（保存后 `wx.canvasToTempFilePath` 的回调路径存在；相册授权在模拟器里跑通）
- [ ] **Step 3: 真机验证（⚠️ 需要用户）**：手机相册里真的出现一张修好的照片；看清晰度（不是被缩过的）。
- [ ] **Step 4: 提交** `git commit -m "feat(小程序): 全尺寸导出存相册（含授权引导）"`

---

### Task 10: 后端微信登录（TDD）

**Files:**
- Modify: `server/db.ts`（MIGRATIONS 数组尾加两条）、`server/session.ts` 或 `server/app.ts`（requireUser 认 Bearer）、`server/account.ts`（`handleWxLogin`）、`server/app.ts`（接线 `POST /api/wx-login`）、`server/config.ts`（读 `WX_APPID` / `WX_SECRET`）
- Test: `server/account.test.ts`（加组）、`server/app.test.ts`（加用例）

**Interfaces:**
- Consumes: `deps.auth`、`issue()`/`sessionExpiry` 既有机制、注入式 fetch（照 `clientFor`/`modeltest` 的注入模式，测试不真打微信）
- Produces:
  - 迁移：`ALTER TABLE users ADD COLUMN wechat_openid TEXT;` + `CREATE UNIQUE INDEX users_wechat_openid ON users(wechat_openid);`（SQLite 的 UNIQUE 索引允许多个 NULL —— 老用户不受影响；迁移串里**不许**出现事务控制语句，见 db.ts 头注释）
  - `handleWxLogin(body, deps: AccountDeps & { fetchImpl; appid; secret }) → { user: PublicUser; token: string }`
  - 路由：`POST /api/wx-login` `{ code }` → `{ user, token }`（**不用 set-cookie**，token 在 body 里给小程序）
  - `requireUser` 的入口翻译：`Authorization: Bearer <token>` 等价于 `Cookie: pr_session=<token>`（⚠️ cookie 名以 `session.ts` 的 `SESSION_COOKIE` 常量为准）

**行为契约（照搬 handleLogin 的纪律）：**
- code 换 openid 失败 / 微信报错 → `HttpError('UNAUTHORIZED', ...)`，**不回显上游原文**。
- openid 已存在 → 直接 issue 新票（无需密码）。
- 新 openid → 建号：`username` 用 `微信用户` + openid 后 6 位（撞名时追加随机后缀重试，唯一裁决在数据库）；`email` 用合成值 `wx-<openid>@wechat.local`（永不发信）；`password_hash` 存**随机 32 字节 hex 占位**（签票用；微信用户永远不用密码登录，也不许用这个身份走 /api/login）。
- 限流：`assertGate(gates.login, 'wx:' + ip, ...)`（和登录同一张闸）。

- [ ] **Step 1: 写失败测试**（account.test.ts 加组）：mock fetchImpl 返回 `{ openid: 'oX1' }` → 断言建号 + 发票 + `wechat_openid` 落库；再调一次 → 断言复用同一个账号（id 相同）；fetchImpl 报 401 风格错误 → 断言 `HttpError UNAUTHORIZED` 且消息不含上游原文。
- [ ] **Step 2: 跑测试确认失败** Run: `npx vitest run server/account.test.ts` Expected: FAIL
- [ ] **Step 3: 实现**（迁移两条 → handleWxLogin → 路由接线 → Bearer 翻译 + app.test.ts 加一条「Bearer 能过 requireUser」）
- [ ] **Step 4: 全量双绿** Run: `npm test && npm run typecheck`
- [ ] **Step 5: 真连一次（⚠️ 需要用户提供 AppSecret）**：用户从微信后台复制 AppSecret → 用户自己往 `.env` 加两行 `WX_APPID=wx3222d31da4ec7edb` / `WX_SECRET=...` → **重启后端**（不热重载）→ 小程序真机登录（下一个任务）时验真。
- [ ] **Step 6: 配置读取** `server/config.ts` 加：`wx: { appid: env.WX_APPID?.trim() ?? '', secret: env.WX_SECRET?.trim() ?? '' }`；**没配时 `/api/wx-login` 回 503 +「后端没有配置微信登录」（照 503 那条既有口径）**。
- [ ] **Step 7: 提交**

```bash
git add server/db.ts server/account.ts server/app.ts server/config.ts server/account.test.ts server/app.test.ts
git commit -m "feat(server): 微信静默登录（code2session + Bearer 会话）"
```

---

### Task 11: 小程序登录 + API 客户端 + 缩图

**Files:**
- Create: `mini/lib/config.ts`, `mini/lib/api.ts`, `mini/lib/auth.ts`, `mini/lib/image/prepare.ts`

**Interfaces:**
- Consumes: Task 10 的 `/api/wx-login`；`mini/lib/shared/size.ts`（`MAX_DIMENSION`、`align32`、`fitWithin`）
- Produces:
  - `config.ts`：`export const API_BASE = 'http://192.168.1.6:5173'`（README 写清怎么改：电脑 IP + `npm run dev` 的端口）
  - `auth.ts`：`getToken(): Promise<string>` —— storage 有就拿；没有/过期 → `wx.login()` → `POST /api/wx-login` → 存 `pr_token` + `pr_user`
  - `api.ts`：`apiPost<T>(path, body): Promise<T>` —— `wx.request` 带 `Authorization: Bearer`；**401 时清 token、重登一次、重试一遍**（只重试一次）；错误统一转 `{ message }`（对齐电脑版 `errorText` 的口径：能读服务端的 message 就用它）
  - `prepare.ts`：
    - `prepareForRouting(photoPath, w, h): Promise<string>` —— 长边 **640**、JPEG dataURL（`wx.canvasToTempFilePath` 默认 jpg → `wx.getFileSystemManager().readFile({ encoding: 'base64' })` 拼 dataURL）
    - `prepareForModel(photoPath, w, h): Promise<{ dataUrl: string; width: number; height: number }>` —— 长边 **2048**、`align32` 修到 32 倍数（两处约束都以 `shared/size.ts` 为准，别抄数字）

- [ ] **Step 1: 实现四个文件**（代码按 Interfaces 的契约；`wx.request` 的 `url = API_BASE + path`）
- [ ] **Step 2: 编译验证** Run: `npx tsc -p mini --noEmit`
- [ ] **Step 3: 真机验证（⚠️ 需要用户 + 后端跑着 + 同一 WiFi）**：在 dev 页加一颗临时按钮「试一试登录」→ 点 → 拿到 token（页面上 print 长度，**别 print token 本身**）→ 后端日志能看到 `/api/wx-login` 200。

**⚠️ 前提**：手机能访问电脑 —— `npm run dev` 跑着 + `手机调试-开防火墙.cmd` 开过 5173 + `API_BASE` 填的是电脑当前局域网 IP（`ipconfig` 看 IPv4）。

- [ ] **Step 4: 提交** `git commit -m "feat(小程序): 静默登录 + API 客户端 + 缩图（640/2048 按 size.ts）"`

---

### Task 12: 「说一句」全流程

**Files:**
- Create: `mini/scripts/mock-server.cjs`
- Modify: `mini/pages/index/index.{wxml,wxss,ts}`

**Interfaces:**
- Consumes: Task 11 的 api/prepare、`shared/protocol.ts` 的 `RouteRequest/RouteDecision`（照它的字段名，一个字母都别改：`paramDeltas` / `editPrompt` / `reply` / `degraded` / `lut` / `preset`）
- Produces: 页面流程 —— 输入条（点击弹键盘、发送箭头）；发送后：`prepareForRouting` → `/api/route`（带当前 15 参数）→ 按 `decision.route` 分流：
  - `params`/`both`：`pipe.render({...当前参数并应用 paramDeltas})` + 更新 activeStyle 点亮
  - `generate`/`both`：`prepareForModel` → `/api/edit`（`editPrompt/width/height` 照协议）→ 换画面
  - `reply` 浮条：输入条上方一条，显示 `decision.reply`（`degraded` 时用「没太听懂，换个说法再试试?」类话术，按后端口径）自动 5 秒淡出
  - 生成中：蒙层（暗化 + 转圈 + **真实秒数**「正在修… N 秒」+「停止」）—— 秒表从请求发出计真实时间；**5 秒内不显示秒数**（跟随电脑版契约）；「停止」= `wx.request` 的 `RequestTask.abort()` + 回到发前状态（提示「停了」）
  - 完成后：新画面 + 右下「撤销」（保存发前 params + 底图路径，点撤销还原）
- Produces: `mock-server.cjs` —— node 原生 http，`/api/route` 返回一个固定决策（`route:'generate'`），`/api/edit` 返回一张本地照片的 dataURL；**不花钱**。

- [ ] **Step 1: 写 mock-server** 并手动 curl 验通：

```bash
node mini/scripts/mock-server.cjs &   # 监听 4399
curl -s -X POST http://127.0.0.1:4399/api/route -d '{"text":"t"}' -H 'content-type: application/json'
```

- [ ] **Step 2: 实现页面全流程**（WXML 结构：输入条 + 浮条 + 蒙层；样式照 mock：输入条胶囊、发送箭头是 `--accent-400` 底 `--accent-ink` 字）
- [ ] **Step 3: mock 冒烟**：`mini/scripts/smoke.cjs` 加一条链：临时把 `config.ts` 指到 `http://127.0.0.1:4399`（或加 `API_BASE_OVERRIDE` 环境变量入口）→ dev 页触发「说一句:把路人去掉」→ 轮询状态：浮条出现 → 蒙层出现（含秒数）→ 撤销出现 → 点撤销 → 画面还原。截图留证。
- [ ] **Step 4: 编译 + 提交** `npx tsc -p mini --noEmit` → `git add mini/ && git commit -m "feat(小程序): 说一句全流程（分流/浮条/蒙层秒表/停止/撤销）+ mock 冒烟"`

---

### Task 13: 验收周（真机清单 + 30 秒线）

**Files:**
- Modify: `mini/README.md`（验收记录）、`.superpowers/mini/`（证据归档）

**Interfaces:**
- Consumes: 全部
- Produces: 一份填好的验收记录（下面每条的实测结果）

- [ ] **Step 1: 电闸全开真机走一遍（⚠️ 需要用户，跟着念清单即可）**

1. 拍照进 → 相册进 → 换一张
2. 每一档风格点一遍（秒变、颜色肉眼正常、无卡顿）
3. 按住看原图（原图/成片对比明显）
4. 说一句：一句话生图（真后端、真花钱 —— 只花一次）、等待秒数真实、能停
5. 存相册：清晰度对（不是缩水版）
6. **30 秒线**：从「选完照片」掐表到「已存到相册」，挑风格那条路 —— 记录实测秒数（目标 ≤30s）

- [ ] **Step 2: 回电脑版确认没被碰坏**

Run: `npm test && npm run typecheck && npm run check:layout`
Expected: 全绿（小程序不该动到电脑版任何行为）。

- [ ] **Step 3: README + 交接记忆**：`mini/README.md` 写全（启动、API 地址、平台行为结论、冒烟怎么跑）；项目记忆写一条「小程序进度」（做到哪/下一步/踩过的坑）。

- [ ] **Step 4: 提交 + 收尾**

```bash
git add mini/README.md && git commit -m "docs(小程序): 验收记录 + 运行手册"
```

---

## Self-Review（对照 spec 逐条）

- spec §1 成功线 → Task 13（30 秒线实测）；§2 选型与探针事实 → 预备知识 + Task 5；§3 架构/目录/同步 → Task 2/3；§3.2 API 地址 → Task 11 config；§4 三态界面 → Task 1/4/6/8/12；§4.4 保存 → Task 9；§5 数据流（640/2048、全图纹理、导出）→ Task 11/5/9；§6 后端 → Task 10；§7 视觉（深色/令牌/字体——**字体子集化未排任务**：第一版先用系统字体，MiSans 子集作为 M5 后的打磨项，**已在 Task 13 之外单列**，见下）；§8 测试三层 → Task 7（冒烟哨兵）+ Task 3/10（单测）+ Task 13（真机）；§9 不做清单 → 全程无任务；§10 风险 → 预备知识 + Task 5/9。
- 字体：⚠️ spec §7 的「MiSans 子集 + Playfair 字标进主包」**未列入本计划** —— 刻意：第一版先跑通功能，字体打磨在真机看过之后再排（体积/混排风险都那时才知道）。这条在验收时向用户摊开。
- 类型一致性：`TonePipeline` 接口在 Task 5 定义、Task 6/8/9/12 消费，签名一致；`RouteRequest/RouteDecision` 字段以 `shared/protocol.ts` 为唯一来源。

## Execution Handoff

计划完成、已存 `docs/superpowers/plans/2026-10-12-miniprogram-outdoor-quick-edit.md`。两种执行方式：

1. **Subagent 驱动（推荐）** —— 每个任务派一个干净 subagent，任务间我做两段式审查；迭代快。
2. **本会话直接执行** —— 按 executing-plans 分批做，在检查点停下来给你看。

选哪个？
