# 微信小程序常用修图版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有微信小程序完善为可手动调色、人像微调、裁剪、保存与草稿恢复的常用修图工具。

**Architecture:** 保留现有单页 WebGL 渲染管线，把“工具状态、参数修改、重置与预设强度”抽成纯函数模块；页面只负责手势、面板切换和 setData。裁剪和再次精修通过生成新 JPG 底图接入现有导出链路，不引入第二套渲染协议。

**Tech Stack:** 微信小程序原生 TypeScript/WXML/WXSS、WebGL2、共享 `Adjustments`、`wx.chooseMedia`、`wx.saveImageToPhotosAlbum`、miniprogram-automator。

**Spec:** `docs/superpowers/specs/2026-10-22-mini-common-editor-design.md`

## Global Constraints

- 不引入新的运行时依赖。
- 共享参数继续使用 `mini/lib/shared/adjustments.ts` 的 `Adjustments`、`ZERO` 和钳制规则。
- 所有可点击控件必须位于 WebGL canvas 之外。
- 保存、裁剪和生成互斥，不能同时争用画布缓冲。
- API 密钥、微信 Secret 和访问令牌不得进入客户端源码、日志或测试输出。
- 正式 API 地址必须是 HTTPS，并加入微信 request 合法域名。
- 每次修改只动 `mini/`、对应测试和文档，不回写 Web 端业务代码。

---

### Task 1: 编辑器纯状态与测试

**Files:**
- Create: `mini/lib/editor.ts`
- Create: `mini/tests/editor.test.mjs`

**Interfaces:**
- Consumes: `Adjustments`, `ZERO` type and object from `mini/lib/shared/adjustments.ts`.
- Produces:
  - `type EditorTool = 'ai' | 'tone' | 'portrait' | 'crop' | null`
  - `type ToneGroup = 'basic' | 'light' | 'color'`
  - `TONE_GROUPS: Record<ToneGroup, readonly (keyof Adjustments)[]>`
  - `PORTRAIT_KEYS: readonly (keyof Adjustments)[]`
  - `resetKeys(params: Adjustments, keys: readonly (keyof Adjustments)[]): Adjustments`
  - `mixPreset(amount: number, preset: Adjustments): Adjustments`

- [ ] **Step 1: Write the failing test**

Create `mini/tests/editor.test.mjs`:

```javascript
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PORTRAIT_KEYS, TONE_GROUPS, mixPreset, resetKeys,
} from '../lib/editor.ts'

const zero = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, temperature: 0, tint: 0,
  vibrance: 0, saturation: 0, clarity: 0, vignette: 0,
  skinSmooth: 0, skinWhiten: 0, skinRosy: 0,
}

test('resetKeys only resets the requested group', () => {
  const current = { ...zero, exposure: 20, contrast: 12, skinSmooth: 40 }
  const next = resetKeys(current, TONE_GROUPS.basic)
  assert.equal(next.exposure, 0)
  assert.equal(next.contrast, 0)
  assert.equal(next.skinSmooth, 40)
})

test('portrait group contains the three supported controls', () => {
  assert.deepEqual([...PORTRAIT_KEYS], ['skinSmooth', 'skinWhiten', 'skinRosy'])
})

test('mixPreset clamps amount and scales all preset fields', () => {
  const preset = { ...zero, exposure: 40, skinSmooth: 60 }
  assert.equal(mixPreset(50, preset).exposure, 20)
  assert.equal(mixPreset(50, preset).skinSmooth, 30)
  assert.equal(mixPreset(150, preset).exposure, 40)
  assert.equal(mixPreset(-20, preset).exposure, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test mini/tests/editor.test.mjs
```

Expected: FAIL because `mini/lib/editor.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `mini/lib/editor.ts` with the exported types, group tables and two pure functions.
`resetKeys` copies `params`; `mixPreset` clamps to 0–100, computes `factor = amount / 100`
and multiplies every numeric value of `preset`, copying only keys present in `preset`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node --test mini/tests/editor.test.mjs
npx tsc -p mini --noEmit
```

Expected: test PASS and TypeScript PASS.

- [ ] **Step 5: Commit**

```powershell
git add mini/lib/editor.ts mini/tests/editor.test.mjs
git commit -m "feat(mini): add editor state helpers"
```

---

### Task 2: 工具行、调色面板与人像面板

**Files:**
- Modify: `mini/pages/index/index.ts`
- Modify: `mini/pages/index/index.wxml`
- Modify: `mini/pages/index/index.wxss`
- Test: `mini/pages/index/index.ts` probe methods

**Interfaces:**
- Consumes: `EditorTool`, `ToneGroup`, `TONE_GROUPS`, `PORTRAIT_KEYS`, `resetKeys` from Task 1.
- Produces:
  - `data.tool: EditorTool`
  - `data.toneGroup: ToneGroup`
  - `data.sliders: Array<{ key: keyof Adjustments; label: string; value: number; min: number; max: number }>`
  - `onToolTap(e)`, `onSliderChanging(e)`, `onSliderChange(e)`, `onResetTool()`, `onResetAll()`
  - `__probeEditor(): { tool: EditorTool; toneGroup: ToneGroup; params: Adjustments }`

- [ ] **Step 1: Add the probe assertions before UI implementation**

Add a page probe that returns the current tool, tone group and params copy. Add an
automator smoke step that calls `onToolTap({ currentTarget: { dataset: { tool: 'tone' } } })`,
moves `exposure` to 20 through `__probeSetAdjustment('exposure', 20)`, asserts the canvas
colors change, then calls `onResetTool()` and asserts `exposure` returns to 0.

Expected before implementation: probe methods are missing.

- [ ] **Step 2: Implement state and handlers**

Add data fields:

```ts
tool: null,
toneGroup: 'basic',
sliders: [],
```

Add handlers with `setData` callbacks calling `fitStage()`. Slider changes write
`this.params` with the shared clamp rules, call `pipe.render(this.params)`, update
`activeStyle`, and leave persistence to the dedicated draft task.

- [ ] **Step 3: Add WXML outside the canvas**

Insert a `.tool-row` after `.styles` and render one panel below it:

- Tool buttons use `data-tool` and `bindtap="onToolTap"`.
- AI keeps the existing message and say-bar markup.
- Tone renders `sliders` with `<slider min max step="1" value bindchanging bindchange>`.
- Portrait renders the three portrait sliders.
- Crop shows its own panel from Task 4.
- Compare is a button with `bindtouchstart="onCompareStart"` and `bindtouchend="onCompareEnd"`.

- [ ] **Step 4: Style the panels**

Use normal-flow layout below the photo, 88rpx minimum hit areas, fixed panel max-height,
horizontal overflow only inside slider rows, and no `position:absolute` over the canvas.

- [ ] **Step 5: Run checks**

```powershell
npx tsc -p mini --noEmit
node scripts/sync-mini-shared.mjs --check
node mini/scripts/smoke.cjs
```

Expected: PASS; the new smoke confirms tone and portrait sliders change params and render.

- [ ] **Step 6: Commit**

```powershell
git add mini/pages/index/index.ts mini/pages/index/index.wxml mini/pages/index/index.wxss
git commit -m "feat(mini): add manual tone and portrait controls"
```

---

### Task 3: 风格强度、对比与草稿恢复

**Files:**
- Modify: `mini/pages/index/index.ts`
- Modify: `mini/pages/index/index.wxml`
- Modify: `mini/pages/index/index.wxss`
- Create: `mini/lib/draft.ts`
- Create: `mini/tests/draft.test.mjs`
- Modify: `mini/pages/index/index.ts` probe methods

**Interfaces:**
- Consumes: `mixPreset` from Task 1, `Adjustments`.
- Produces:
  - `data.styleAmount: number`
  - `data.hasDraft: boolean`
  - `draft.save(input)`, `draft.load()`, `draft.clear()`
  - `onStyleAmount(e)`, `onCompareStart()`, `onCompareEnd()`, `onRestoreDraft()`
  - `__probeDraft()` and `__probeCompare()`

- [ ] **Step 1: Write draft tests**

Test round-trip of `{ photoPath, width, height, params, presetId, styleAmount, at }`,
reject age over seven days, and reject malformed records.

- [ ] **Step 2: Implement the storage module**

Use a single storage key `pinkrose:draft:v1`. Validate all numeric fields, clamp
parameters with `clampAdjustments`, and return `null` on malformed data.

- [ ] **Step 3: Implement compare and style amount**

Compare uses `pipe.render(ZERO)` on start and `pipe.render(this.params)` on end.
Style amount recomputes the preset from its original object with `mixPreset`, never
multiplies the already-mixed params repeatedly.

- [ ] **Step 4: Implement draft persistence**

Copy the selected photo into `USER_DATA_PATH/draft/current.jpg`. Save on slider change,
style change, crop completion, generation success and page hide. Restore only after the
canvas is mounted; clear stale drafts and show the empty state when the file is missing.

- [ ] **Step 5: Run checks**

```powershell
node --test mini/tests/draft.test.mjs
npx tsc -p mini --noEmit
node mini/scripts/smoke-say.cjs
```

Expected: PASS; compare restores params, style amount is monotonic, draft restores after
page reload.

- [ ] **Step 6: Commit**

```powershell
git add mini/lib/draft.ts mini/tests/draft.test.mjs mini/pages/index
git commit -m "feat(mini): persist edits and add compare"
```

---

### Task 4: 裁剪底图链路

**Files:**
- Create: `mini/lib/image/crop.ts`
- Create: `mini/tests/crop.test.mjs`
- Modify: `mini/pages/index/index.ts`
- Modify: `mini/pages/index/index.wxml`
- Modify: `mini/pages/index/index.wxss`

**Interfaces:**
- Consumes: `wx.createOffscreenCanvas`, `wx.getImageInfo`, `wx.canvasToTempFilePath`.
- Produces:
  - `type CropRatio = 'original' | '1:1' | '4:5' | '3:4' | '16:9'`
  - `cropRect(width, height, ratio): { x, y, w, h }`
  - `rotateSize(width, height, quarterTurns): { width, height }`
  - `cropToFile(input): Promise<{ path; width; height }>`
  - `onCropRatio`, `onCropRotate`, `onCropFlip`, `onCropCancel`, `onCropApply`

- [ ] **Step 1: Write geometry tests**

Test 1:1 central square, 4:5 portrait crop, 16:9 landscape crop, odd dimensions,
one and three quarter turns, and flip preserving dimensions.

- [ ] **Step 2: Implement pure geometry**

Keep all math integer-safe and clamp the crop rectangle inside the source dimensions.

- [ ] **Step 3: Implement file rendering**

Load the source with offscreen canvas image, apply quarter turns and horizontal flip,
crop, then export JPG quality 0.95. Return temporary path and actual dimensions.

- [ ] **Step 4: Wire page state**

Crop completion disposes and restarts the rendering pipeline with the new path while
preserving `this.params`. Cancel changes nothing. Block crop while generating or saving.

- [ ] **Step 5: Run checks**

```powershell
node --test mini/tests/crop.test.mjs
npx tsc -p mini --noEmit
node mini/scripts/smoke.cjs
```

Expected: PASS; 1:1 output dimensions equal; cancel preserves the original path.

- [ ] **Step 6: Commit**

```powershell
git add mini/lib/image/crop.ts mini/tests/crop.test.mjs mini/pages/index
git commit -m "feat(mini): add crop rotate and flip"
```

---

### Task 5: 作品再次精修、默认风格与服务状态

**Files:**
- Modify: `mini/pages/works/works.ts`
- Modify: `mini/pages/works/works.wxml`
- Modify: `mini/pages/works/works.wxss`
- Modify: `mini/pages/me/me.ts`
- Modify: `mini/pages/me/me.wxml`
- Modify: `mini/pages/me/me.wxss`
- Modify: `mini/pages/index/index.ts`

**Interfaces:**
- Consumes: `works.list()`, page navigation, `apiPostNoAuth` or token probe.
- Produces:
  - Works action `onEditAgain(id)` navigating to edit tab with the work file path.
  - `DEFAULT_STYLE_KEY = 'pinkrose:default-style:v1'`.
  - My page status rows for login, service and model.

- [ ] **Step 1: Add works edit action**

Open the selected work full-size file as a new base image, reset params to `ZERO`, and
clear any old draft. Do not claim the baked JPEG can be undone to an earlier recipe.

- [ ] **Step 2: Add default style**

Store a preset id in local storage; apply it only when `applyPickedPhoto` is called for
a newly selected image.

- [ ] **Step 3: Add service status**

Use existing auth token and API module. Show three states with human-readable text and
a retry button. Never display token length or key content.

- [ ] **Step 4: Update privacy copy**

State camera, album, AI upload and local-only works behavior accurately.

- [ ] **Step 5: Run checks**

```powershell
npx tsc -p mini --noEmit
node mini/scripts/smoke-works.cjs
```

Expected: PASS; again-edit opens the baked image, default style applies to the next photo,
status rows render without secrets.

- [ ] **Step 6: Commit**

```powershell
git add mini/pages/works mini/pages/me mini/pages/index/index.ts
git commit -m "feat(mini): connect works and preferences"
```

---

### Task 6: 发布配置、冒烟与文档

**Files:**
- Modify: `mini/lib/config.ts`
- Modify: `mini/README.md`
- Modify: `docs/苹果端验收清单.md`
- Modify: `mini/scripts/smoke.cjs`
- Modify: `mini/scripts/smoke-say.cjs`
- Modify: `mini/scripts/smoke-works.cjs`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: a release checklist and reproducible local verification commands.

- [ ] **Step 1: Add smoke assertions**

Cover tool switching, each manual slider, style strength monotonicity, compare restore,
crop geometry, draft reload and works again-edit.

- [ ] **Step 2: Document configuration**

Document formal AppID replacement, HTTPS request domain, mock/dev override removal,
privacy declarations and package-size checks.

- [ ] **Step 3: Run all automated checks**

```powershell
node scripts/sync-mini-shared.mjs --check
npx tsc -p mini --noEmit
node --test mini/tests/*.test.mjs
node mini/scripts/smoke.cjs
node mini/scripts/smoke-say.cjs
node mini/scripts/smoke-works.cjs
```

Expected: all PASS.

- [ ] **Step 4: Run real-device checklist**

Use the iPhone checklist in `mini/README.md`: camera, album, save permission, compare,
manual sliders, crop, works again-edit, draft restore and AI failure recovery.

- [ ] **Step 5: Commit**

```powershell
git add mini docs/苹果端验收清单.md
git commit -m "docs(mini): document release verification"
```

