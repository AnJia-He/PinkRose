# 设计跟进实现计划（2026-10-11）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页从"三格并排"重做成**单列分组**（治"业余、散漫"）；并清掉体检揪出的
六件小毛病 + 两处顺手（落地页假话 / 错误态标准件 / 404 / 路由重试 / 下载统一 / aria 两行 /
色号表过时句 / 模型页面包屑 / 作品空态按钮）。

**Architecture:** 全部是既有页面与组件的改造，不引入新架构。唯一的新件是两个小 UI
组件（`ui/kit/ErrorState.tsx`、`ui/NotFound.tsx`）和 `view.ts` 的一个新视图 `notfound`。
设置页重设计**只动排版层**（AccountPage.tsx 的 JSX 结构 + styles.css 的 account 段 +
饼图那一小块 DOM 搬家）——行为、文案、测试锚点类一律不动。

**Tech Stack:** React 18 + TypeScript + 原生 CSS；Vitest（jsdom）+ Playwright 真机截图。

**Spec:** `docs/superpowers/specs/2026-10-11-design-followups-design.md`（动手前通读；
体检全文在 `.superpowers/scratch/design-audit/report.md`）。

## Global Constraints

- **提交前必须两绿**：`npm test` + `npm run typecheck`（vitest 不做类型检查，两个都要跑）。
- **动界面文案之前先读** `docs/文案规范.md`；文案导出核对跑 `npm run check:copy`。
- **全站不弹窗**：新交互一律"就地展开 / 就地确认"。
- 面向用户的话：说「你」不说「您」；错误句 = 哪不对 + 怎么办；两边都要说的话进 `shared/copy.ts`。
- 用户可见的新字符串要有测试**按字面量钉**。
- **加 CSS 会被常驻守卫查**：`src/styles.ruler.test.ts`（app 字号只许 12/13/14/15/17/20/22/26/30；
  字重只许 400/600；图标必须显式 `strokeWidth={1.5}`）。
- **不许删测试锚点类**（各任务里点名的那几个）；行号引用都是 2026-10-11 实测，对不上**以代码为准**。
- 每个任务一个提交；尾注 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: 设置页单列分组重设计

**Files:**
- Modify: `src/ui/AccountPage.tsx`（版式：三格 → 单列分组；用量区横排）
- Modify: `src/styles.css`（`.account-inner` / `.account-grid` / `.usage-figure` 段 + 更新那几段历史注释）
- Modify: `src/App.account.test.tsx`（结构断言更新 + 新增）

**Interfaces:**
- Produces: `restPctLabel(ratio: number | null): string`（从 `UsagePie` 里搬出来的百分比
  格式化，导出给页面用；`UsagePie` **不再渲染** `.usage-pie-pct`）。
- 保留的锚点类（测试在用，一个不许丢/改语义）：`.account`、`.account-name`、`.account-label`、
  `.account-row`（+ `.account-row-label` 按文字找行）、`.account-stats`、`.account-signout`、
  `.account-form`、`.account-submit`、`.account-msg`、`.account-quota-warn`、`.account-quota-go`。

- [ ] **Step 1: 先跑 `npx vitest run src/App.account.test.tsx` 拿基线（应全绿）**，再写新结构断言（先红）：

```ts
// 新样子：单列三组、用量区横排的右列
it('版式：三个分组按单列排（不再并排三个 tile 一行）', ...)   // .account-grid 里恰有 3 个 .account-tile
it('用量区：百分比和「N 张作品」进了右侧 .usage-copy（饼图上只留那两条标签）', ...)
it('旧契约没丢：.account-row 按标签找得到「用户名 / 改密码 / 注销账号」，.account-name 恰等于用户名', ...) // 现成的用例已覆盖，保持绿
```

- [ ] **Step 2: 跑红 → 实现**

AccountPage.tsx：
- `UsagePie`：删掉尾部 `{label !== '' && <span className="usage-pie-pct">剩余 {label}</span>}`
  那段（连同 `restPct`/`label` 计算），改成导出

```ts
/** 百分比那行的格式化（★ 2026-10-11 从 UsagePie 里搬出来 —— 单列版式里这一行挪到右列，
    和「N 张作品」做一竖排。规则一个字没动：>99.95 → 「>99.9%」、>90 一位小数、其余取整。 */
export function restPctLabel(ratio: number | null): string { … }
```

- 页面里 `.usage-figure` 改成两段：`<UsagePie …/>`（饼 + 两条压图标签）+ 新的
  `<div className="usage-copy">`（`<span className="usage-pie-pct">剩余 {restPctLabel(ratio)}</span>`
  + 现成的 `.account-stats`）。
- 版式注释按新事实重写（那段"三格并排怎么来的"历史保留 + 追加 2026-10-11 一节：
  用户「很业余很散漫」→ 病根 = 仪表盘排版、参差、孤悬，见 spec §一）。

styles.css：
- `.account-inner { max-width: 680px }`（原 1200）。
- `.account-grid`：`auto-fit` → 单列（`display: flex; flex-direction: column; gap: 28px;` 或等价），
  注释照实更新。
- `.usage-figure`：宽屏 `display: flex; align-items: center; gap: 28px;`（`.usage-copy` 竖排右列），
  窄屏靠 `flex-wrap: wrap` 自然叠；`.usage-pie-wrap` 的内部（饼、两条绝对定位标签）**不动**。
- 色号/字号只许用既有令牌与守卫阶梯。

- [ ] **Step 3: 跑绿 + 真机截图人眼过**

Run: `npx vitest run src/App.account.test.tsx && node .superpowers/scratch/_shot-account.mjs`
（脚本会注册临时账号、落 `verify-shots/account-1440.png` / `account-390.png` —— **看这两张图**，
并跑 `taste-skill` 对照；宽屏饼图应在左、数字在右，窄屏上下叠。）

- [ ] **Step 4: 全量两绿 + 提交**

```bash
npm test && npm run typecheck
git add src/ui/AccountPage.tsx src/styles.css src/App.account.test.tsx
git commit -m "feat(设置页): 三格并排 → 单列分组 —— 治'业余散漫'（仪表盘排版/参差/孤悬）"
```

---

### Task 2: 「打不开」标准件 + 404 分流 + 未知网址页

**Files:**
- Create: `src/ui/kit/ErrorState.tsx`、`src/ui/NotFound.tsx`
- Modify: `src/ui/GalleryPage.tsx` / `src/ui/SessionsPage.tsx` / `src/ui/WorkDetailPage.tsx`（错误态接线）
- Modify: `src/ui/view.ts`（`notfound` 视图）
- Modify: `src/App.tsx`（渲染 notfound）
- Modify: 相应测试（`src/App.gallery.test.tsx` / `src/App.sessions.test.tsx` / `src/App.test.tsx`；
  若有 `view` 的测试文件一并改）

**Interfaces:**
- Produces: `ErrorState({ text, onRetry, retryLabel = '再试一次' })`；
  `View` 新增 `{ kind: 'notfound'; path: string }`（`pathOf` 回原路径——地址栏不改写）。
- Consumes: `errorText(e, fallback)`（`src/api/client.ts`，已有）；404 判据 = `ApiError` 的
  status/code（动手前看一眼 `client.ts` 的 `ApiError` 形状，以代码为准）。

- [ ] **Step 1: 写失败测试**

```ts
// App.gallery / App.sessions：错误态现在是居中一件 + 能点的出口
it('作品页打不开：居中的一句 + 一颗「再试一次」，点了就重新 fetch（第一次 500、第二次成功）', ...)
it('对话页打不开：同上（两页一个形状）', ...)
it('详情页 404：说「这张作品不在了。」+「回作品」按钮 —— 不再出现「刷新一下页面」', ...)
it('详情页网络错（非 404）：保留重试按钮 + 同一句话', ...)
// App 级：未知网址
it('认不出的网址落在「没找到这一页」，地址栏保持原样，两颗按钮各自能去对地方', ...)
```

- [ ] **Step 2: 跑红 → 实现**

- `ErrorState.tsx`：`<div className="empty-state error-state">` 里一个
  `<p className="empty-state-title">{text}</p>` + `<Btn onClick={onRetry}>{retryLabel}</Btn>`
  （视觉语言照 `SessionsPage` 的空态；类名复用 `.empty-state*`，新增的只有 `.error-state` 这类微调）。
- 三页接线：
  - GalleryPage / SessionsPage：把各自的加载函数提出来（现成 effect 里那份），`failed` 分支
    渲染 `ErrorState text={failed} onRetry={load}`；**删掉**「刷新一下页面，再试一次。」那句
    （连同它的 `gallery-hint`）。⚠️ 有测试钉着那句的，一并更新。
  - WorkDetailPage：catch 里把"是不是 404"留下来（存一份 `gone: boolean` 或原样存错误对象）；
    `failed && !work` 分支：404 → `ErrorState text="这张作品不在了。" retryLabel="回作品" onRetry={onBack}`；
    其余 → `ErrorState text={failed} onRetry={reload}`。
- `view.ts`：`View` 加 `notfound`；`viewFromPath` 最后一行 `return { kind: 'notfound', path }`
  （不再退落地页；`/` 本体照旧是 landing）；`pathOf` 对 notfound 返回 `v.path`。
  ⚠️ 顶部那段大注释按新口径重写（"认不出的路径退回落地页"→"给一个诚实的找不到"）。
- `NotFound.tsx`：居中一件 —— 标题**「没找到这一页」**、正文**「地址可能打错了，或者这一页
  已经不在了。」**、两颗按钮**「回到修图」「看产品介绍」**（各自走 `onGo({kind:'edit'})` 与
  门面那套 —— 照 `Nav.tsx` 里「产品介绍」的走法，别自己拼网址）。App 在 `kind === 'notfound'`
  时渲染它（摆在落地页/登录页那一层）。
- 文案规范里如果记着「刷新一下页面，再试一次。」，**本任务不动那份文件**（统一由 Task 4 收口）。

- [ ] **Step 3: 跑绿 + 全量两绿 + 真机看一眼 404 页**

Run: `node .superpowers/scratch/_shot-account.mjs` 之后手动补一张：开
`http://localhost:5173/totally/bogus` 截图确认（或写两行临时探针）——看地址栏没被改写、
页面长得像样。

- [ ] **Step 4: 提交**

```bash
git add src/ui/kit/ErrorState.tsx src/ui/NotFound.tsx src/ui/GalleryPage.tsx src/ui/SessionsPage.tsx src/ui/WorkDetailPage.tsx src/ui/view.ts src/App.tsx src/App.gallery.test.tsx src/App.sessions.test.tsx src/App.test.tsx
git commit -m "feat(收尾): 「打不开」居中可重试 + 404 分流 + 未知网址页 —— 错误态也给出口"
```

---

### Task 3: 路由失败挂「再试一次」

**Files:**
- Modify: `src/App.tsx`（`send` 的 catch 分支 + 接线）
- Modify: `src/ui/ChatPanel.tsx`（重试按钮扩展到"路由失败"这一档）
- Modify: `src/App.test.tsx`（新断言）

**Interfaces:**
- Consumes: ChatPanel 现成的 `.bubble-retry` / `retryId` 那套（生成失败用的，2026-10-10）；
  「现场」样板 = `src/app/useGeneration.ts` 的 `retryRef`（存原文 + 两把尺子：会话与 baseSeq）。
- 行为契约：路由失败 → 失败气泡下**一颗「再试一次」**；点了 = **原样重发同一句话**
  （现场只存那句原文 + 当时的两把尺子）；文字按钮照生成失败那颗。

- [ ] **Step 1: 写失败测试（先红）**

```ts
it('路由失败：失败气泡下有「再试一次」，点了用同一句话重发（第二次成功 → 正常走下去）', ...)
it('点了重试但会话已经切走/画面已变：不动它（照生成重试那两把尺子）', ...)
```

- [ ] **Step 2: 跑红 → 实现**

- App：`say()` 的返回值如果能拿到消息 id 就用它标记那颗气泡（拿不到就小改让它回 id）；
  catch 里在 `say(...)` 之后记下 `routeRetry = { id, text }`（照 `useGeneration` retryRef
  的两把尺子存 `seq` / `sessionId`）；点重试时先验尺子，再 `postRoute` 原样重发，
  成功后按正常流程 `applyDecision`（等价于用户把那句话再说一遍）。
- ChatPanel：重试按钮的渲染条件从"仅生成失败"扩到"生成失败 **或** 路由失败"——
  两套状态各给一个回调 prop（`onRetry` / `onRetryRoute`），别硬塞成一个。
- ⚠️ 重试期间按钮隐藏/禁用与生成那颗一致；`useGeneration` 现成实现别改语义。

- [ ] **Step 3: 跑绿 + 全量两绿 + 提交**

```bash
git add src/App.tsx src/ui/ChatPanel.tsx src/App.test.tsx
git commit -m "feat(对话): 路由失败也挂「再试一次」—— 10-10 那批唯一没收尾的一截"
```

---

### Task 4: 文案与规范批（落地页假话 / 下载统一 / 色号表句）

**Files:**
- Modify: `src/ui/LandingPage.tsx`（how 一格改写 + 注释记录）
- Modify: `src/ui/Banners.tsx`（:92 按钮） / `src/ui/WorkDetailPage.tsx`（下载按钮文字）
- Modify: `src/styles.css`（色号表那句，:63-64）
- Modify: `docs/文案规范.md`（名字表 + 词条 + 错误句记录；**本任务统一收口 Task 2 的新文案**）
- Modify: 相关测试（grep「点哪一句」「下载到电脑」「下载到我的电脑」）

**改什么（逐字）**：
- `LandingPage.tsx:314-315`：

```tsx
<h3>点哪一版，回哪一版</h3>
<p>改过的每一版都排在照片上方那圈里 —— 点哪一格就回哪一版。调色不伤原图，照片随时能回到刚上传的样子。</p>
```

  文件顶部那段"三个小标题为什么这么起"的注释（约 298-306 行）**追加一节**：2026-10-11
  改因 —— 原来的「点哪一句就回到哪一步」在 10-06 退役后成了假话（体检抓到），现在是转盘。
- `Banners.tsx:92`：「下载到电脑」→「下载」。
- `WorkDetailPage.tsx` 下载按钮：「下载到我的电脑」→「下载」（注释里引用旧话的地方可留）。
- `styles.css:63-64`：色号表里说气泡"深蓝"的半句 →「深青（薄荷深档）」。
- `docs/文案规范.md`：
  - 名字表：「下载」（把这次统一的事记一笔）；「回到这一步」词条更新为**能力名**
    （只活在转盘格子的 aria-label 里，门面不再拿它当标题/描述）；
  - 新增错误句/页面文案条目：**「没找到这一页」/「地址可能打错了，或者这一页已经不在了。」/
    「这张作品不在了。」**（Task 2 落的）；**「刷新一下页面，再试一次。」记为退役中** ——
    作品/对话/详情三页随 T2 已退役；`ModelSettings.tsx:177` / `LutSettings.tsx:273` 两处
    随 T5 收齐（T5 完成后全站归零）——措辞带上这个限定，别写成"已全站退役"；
  - 改完跑 `npm run check:copy` 确认 exit 0。

- [ ] **Step 1: 写失败测试**（落地页那格的新文字按字面量钉；两处下载新名字按字面量钉）
- [ ] **Step 2: 跑红 → 按上面逐字改 → 跑绿**
- [ ] **Step 3: 全量两绿 + 提交**

```bash
git add src/ui/LandingPage.tsx src/ui/Banners.tsx src/ui/WorkDetailPage.tsx src/styles.css docs/文案规范.md src/App.test.tsx src/App.gallery.test.tsx
git commit -m "docs(文案): 落地页改说转盘 + 「下载」全站一名 + 规范同步（错误句/404/词条）"
```

---

### Task 5: 小件收尾（aria 两行 + 模型页面包屑 + 作品空态按钮）

**Files:**
- Modify: `src/ui/Nav.tsx`（aria-current）/ `src/ui/Banners.tsx`（通知条 role）
- Modify: `src/ui/GalleryPage.tsx` + `src/App.tsx`（空态按钮）/ `src/ui/ModelSettings.tsx` + `src/App.tsx`（面包屑）
- Modify: `src/ui/ModelSettings.tsx` + `src/ui/LutSettings.tsx`（**错误态换 ErrorState** —— 见下面第 5 项）
- Modify: 相应测试

- [ ] **Step 1: 写失败测试**

```ts
it('导航当前项有 aria-current="page"（含人物图标那颗）', ...)
it('通知条 role="status"（读屏能听见「存好了…」这类通报）', ...)
it('作品空态有一颗「去改一张」，点了去修图页', ...)
it('模型设置页头有「← 个人设置」，点了回设置页', ...)
it('模型设置 / Lut 页打不开：也是居中的「打不开」块 + 一颗「再试一次」（旧句退役）', ...)
```

- [ ] **Step 2: 跑红 → 实现**

- `Nav.tsx`：`ITEMS` 循环里 `aria-current={here === kind ? 'page' : undefined}`；
  人物图标那颗 `aria-current={atAccount ? 'page' : undefined}`。
- `Banners.tsx`：**通报条**（`.notice` 那块；提问条与存失败条不动）根元素加 `role="status"`。
  ⚠️ 忙态气泡**不加** aria-live（spec §三 的裁定，别自作主张）。
- `GalleryPage.tsx`：空态那句「左边点「修图」，做一张试试。」→ 一颗
  `<Btn onClick={onNew}>去改一张</Btn>`（和对话列表空态同款；props 加 `onNew`，
  App 传与 `SessionsPage` 同一条路）。窄屏"左边"指错方向的病根随之消失。
- `ModelSettings.tsx`：`<h1 className="models-title">` 上方加与作品详情「← 作品」同款的
  面包屑按钮「← 个人设置」（类名照抄详情页那颗的样式来源；props 加 `onBack`，
  App 传 `() => go({ kind: 'account' })`）。
- `ModelSettings.tsx:177` / `LutSettings.tsx:273`：两处仍是旧写法的错误态
  （「刷新一下页面，再试一次。」）→ 换成同款 `ErrorState`（`onRetry` = 重拉各自的数据）；
  旧句连同钉它的测试一并退役 —— 至此全站归零。

- [ ] **Step 3: 跑绿 + 全量两绿 + 提交**

```bash
git add src/ui/Nav.tsx src/ui/Banners.tsx src/ui/GalleryPage.tsx src/ui/ModelSettings.tsx src/App.tsx src/App.gallery.test.tsx src/App.account.test.tsx src/App.test.tsx
git commit -m "feat(收尾): aria-current + 通知 live + 模型页面包屑 + 作品空态按钮"
```

---

## 自检记录（写完计划后对着 spec 过）

- Spec §一（设置页）→ Task 1；§二 #1 → T4、#2/#3 → T2、#4 → T3、#5 → T4、#6 → T5、
  两处顺手（色号表句 → T4；模型页面包屑 + 作品空态 → T5）。§三（显式不做）在 T5/T1 的
  约束里点名。**无缺口**。
- 跨任务共享文件：`WorkDetailPage.tsx`（T2 错误区 / T4 按钮字）、`styles.css`（T1 account 段 / T4 色号句）、
  `Banners.tsx`（T4 按钮字 / T5 role）、`GalleryPage.tsx`（T2 错误区 / T5 空态）、
  `App.tsx`（T2/T3/T5 各一处接线）——**全部先后串行**（SDD 一次只派一个实现者），无并行冲突。
- 文案规范只由 **T4** 收口（T2 只落代码与测试，不碰文档）。
