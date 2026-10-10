# 「我的预设」实现计划（2026-10-10）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能把当前 15 个调色参数存成命名预设；在预设栏一键用、在对话里说「用我那套 X」也能用；
在调色面板里存 / 改名 / 删。

**Architecture:** 全照「Lut（滤镜）」那条既成的线做平行实现：服务端一张表 + 四个动词语义照
`server/luts.ts` 骨架（**不搬**文件 I/O / 解析 / 引用清理三样）；对话那条走"清单上行、模型只回名字、
前端对号赋值"（和 Lut 完全同构）。前端 `shared/preset.ts` + `api/presets.ts` + `app/usePresets.ts`
三层照 Lut 的对应件。

**Tech Stack:** React 18 + TypeScript + 原生 CSS；Node 后端 + SQLite（`server/db.ts` 的迁移数组）。

**Spec:** `docs/superpowers/specs/2026-10-10-my-presets-design.md`（**动手前通读**；本文里
"§N"指的是那份文档的节号）。

## Global Constraints

- **提交前必须两绿**：`npm test` + `npm run typecheck`（vitest 不做类型检查，两个都要跑）。
- **动界面文案之前先读** `docs/文案规范.md`；文案导出核对跑 `npm run check:copy`。
- **迁移只许往后追加**（`server/db.ts` 的 `MIGRATIONS`）：老条目一个字符都不许改/删；
  `server/db.test.ts` 的 `PINNED_MIGRATIONS` **只追加新指纹**，不许重生成整份。
- **全站不弹窗**：新交互一律"就地展开 / 就地确认"（照 `SessionsPage` / `LutSettings` 的先例）。
- 面向用户的话：说「你」不说「您」；错误句 = 哪不对 + 怎么办；两边都要说的话进 `shared/copy.ts`。
- 用户可见的新字符串要有测试**按字面量钉**（照 Lut 那组测试的样子）。
- **后端改动不热重载** —— 动 `server/` 之后要重启 dev 服务器才生效（前端是 HMR）。
- 新前端逻辑进 `src/app/` 下的 hook（`App.tsx` 已 2300+ 行，**不再往里硬塞逻辑**，只接线）。
- 行号引用都是 2026-10-10 工作区实测；如果发现对不上，**以代码为准**并顺手在提交信息里记一句。

---

### Task 1: 服务端——表 + 四个动词

**Files:**
- Modify: `server/db.ts`（MIGRATIONS 末尾追加第 7 条）
- Modify: `server/db.test.ts`（`PINNED_MIGRATIONS` 追加指纹）
- Create: `server/presets.ts`
- Create: `server/presets.test.ts`
- Modify: `server/app.ts`（`/api/luts` 块之后插四条路由 + `presetDeps`）
- Modify: `server/app.test.ts`（照 luts 那组加路由测试）

**Interfaces:**
- Consumes: `server/clock.ts` 的 `nowMs(deps)`；`server/http.ts` 的 `HttpError/asObject/str`；
  `shared/adjustments.ts` 的 `clampAdjustments`、`PARAM_KEYS`。
- Produces（后面所有任务依赖）：
  - `shared/preset.ts` 的 `MAX_PRESETS`、`presetNameOk`（**本任务先建这个文件的最小版**，
    Task 2 再补别的）
  - `server/presets.ts` 导出：`listPresets(user, deps)` → `{ presets: PresetRowMeta[] }`；
    `createPreset(body, user, deps)` → `{ preset }`；`renamePreset(id, body, user, deps)` → `{ preset }`；
    `deletePreset(id, user, deps)` → `{ ok: true }`
  - HTTP：`GET/POST /api/presets`、`PATCH/DELETE /api/presets/:id`

- [ ] **Step 1: 建 `shared/preset.ts` 的最小版**

（`PresetMeta` 的完整版在 Task 2 补；这里先要 `MAX_PRESETS` 和 `presetNameOk`，服务端马上用。）

```ts
import type { Adjustments } from './adjustments.ts'

/**
 * ★ 2026-10-10：「我的预设」—— 用户存下来的**一整套 15 个调色参数**。
 *
 * 它只含参数，**不含 Lut**（设计 §0）：滤镜是另一个资源（有自己的强度和删除语义）。
 * 上限 30 与 `MAX_LUTS` 对称（设计 §2.2）——也是"发给模型最多 30 个"那个数的出处。
 */
export const MAX_PRESETS = 30
export const MAX_PRESET_NAME = 30

/** 预设的名字要 1–30 个字符（和 `lutNameOk` 同一把尺子）。 */
export function presetNameOk(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_PRESET_NAME
}

/** 对号用：trim + 忽略大小写（和 `sameLutName` 同一把尺子）。 */
export function samePresetName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** 服务端回给前端的元数据（params 随列表一起回，没有单独的详情路由）。 */
export type PresetMeta = {
  id: number
  name: string
  params: Adjustments
  createdAt: number
}
```

- [ ] **Step 2: 追加迁移（`server/db.ts`）**

在 MIGRATIONS 数组**末尾**（第 6 条 luts 之后）追加：

```ts
  // #7 presets（★ 2026-10-10「我的预设」）：用户存下来的一套 15 参数。
  // 不再有 bytes 列 —— 它不进 5 GB 配额（设计 §2.1：纯 JSON 不占共享盘，
  // 防滥用走条数上限）。
  `
  CREATE TABLE presets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL COLLATE NOCASE,
    params     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE INDEX presets_user ON presets(user_id);
  `,
```

- [ ] **Step 3: 跑 db 测试看红（指纹断言）**

Run: `npx vitest run server/db.test.ts`
Expected: FAIL —— `PINNED_MIGRATIONS.length` 那条红（`7 !== 6`）。**这是有意的信号**。

- [ ] **Step 4: 追加指纹（`server/db.test.ts`）**

生成第 7 条迁移的 sha256（照文件头注释给的方式）：

```bash
node --input-type=module -e "import {MIGRATIONS} from './server/db.ts'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(MIGRATIONS[6]).digest('hex'))"
```

把输出**追加到 `PINNED_MIGRATIONS` 数组末尾**（不要重生成整份）。

- [ ] **Step 5: 跑绿**

Run: `npx vitest run server/db.test.ts`
Expected: PASS。

- [ ] **Step 6: 写 `server/presets.test.ts` 的失败测试**

照 `server/luts.test.ts` 的结构（`:memory:` 开库、真 deps）。用例（**名字与断言按这里的写**）：

```ts
describe('预设 CRUD', () => {
  it('存一套 → 列出来（按创建时间倒序）', ...)        // createPreset 后 listPresets 能拿到，params 原样
  it('名字重复（忽略大小写）不许存 —— 存和改名两处同一个判据', ...) // '黄昏' vs ' 黄昏 ' 两次 → 第二次 400
  it('参数会被钳制：越界的数字入库前收进合法范围', ...)   // exposure: 999 → 100（clampAdjustments）
  it('上限 30：满了再存 → 400，且用的是共享那句文案', ...) // 断言 message === PRESET_LIMIT_REACHED(MAX_PRESETS)
  it('改名：改成别人的名字 400；改成自己的同一名字（同名跳过查重）OK', ...)
  it('删：删掉之后列表里没有；删别人的 / 不存在的 → 404（同一句话）', ...)
  it('名字 0 字 / 31 字 → 400', ...)
})
```

- [ ] **Step 7: 跑测试看红**

Run: `npx vitest run server/presets.test.ts`
Expected: FAIL —— `server/presets.ts` 还不存在。

- [ ] **Step 8: 实现 `server/presets.ts`**

骨架**照 `server/luts.ts`** 写，第 1-48 行（deps / Row / toMeta / loadOwned / list / assertNameFree）
几乎可以照着换名，差异逐条：

- `PresetDeps = { db: Db; now?: () => number }` —— **没有 storage**；
- `PresetRow = { id, user_id, name, params: string, created_at }`；
- `toMeta` 要把 `params` 从 JSON 字符串解回来：`params: JSON.parse(r.params) as Adjustments`
  ——解析失败怎么办？**不许**静默给空对象：`try { … } catch { throw new HttpError('INTERNAL', …) }`
  （坏 JSON 是真异常，照 `server/sessions.ts` 解 steps 失败那处的口径——先看它怎么处理的，跟它一致）；
- `createPreset`：`str(o.name).trim().slice(0, MAX_PRESET_NAME)` → `presetNameOk` 断言 →
  `clampAdjustments(o.params ?? {})` → 条数上限（`MAX_PRESETS`，满了抛
  `HttpError('BAD_REQUEST', PRESET_LIMIT_REACHED(MAX_PRESETS))`）→ `assertNameFree` →
  `INSERT INTO presets (user_id, name, params, created_at) VALUES (?,?,?,?)`（`nowMs(deps)`），
  并照 luts 那条兜 `UNIQUE` 冲突（并发时两条同名的窗口）→ 返回 `{ preset }`；
  ⚠️ `clampAdjustments` 拿不到完整 15 键时补零——看 `shared/adjustments.ts` 的实现确认它自己会补
  （`normalizeAdjustments` 或同款函数，用**既有**的那个，别新写）；
- `renamePreset`：照 `renameLut`（同名跳过查重那条注释也要）；
- `deletePreset`：**没有** luts 那半"清会话引用"（设计 §3：预设不被任何东西引用），
  就是 `DELETE FROM presets WHERE id = ?` + `{ ok: true }`。

- [ ] **Step 9: 跑绿**

Run: `npx vitest run server/presets.test.ts`
Expected: PASS。

- [ ] **Step 10: 挂路由（`server/app.ts`）**

在 luts 那组路由（约 618-657 行）之后、`/api/route`（约 658 行）之前插入。照 luts 每条的形状：
先 `const user = requireUser(deps, req, res)`（**先认人、再读体**），再调函数、`sendJson`。
`const presetDeps = { db: deps.auth.db, now: deps.auth.now }` 加在 `lutDeps`（约 293 行）旁边。

```ts
if (req.method === 'GET' && path === '/api/presets') { … }
if (req.method === 'POST' && path === '/api/presets') { … await readJsonBody(req) … }
const presetOne = /^\/api\/presets\/(\d+)$/.exec(path)
if (presetOne && req.method === 'PATCH') { … }
if (presetOne && req.method === 'DELETE') { … }
```

（正则**必须带 `$` 锚定**——app.test.ts 有专门一条钉"多一截的路径必须 404"。）

- [ ] **Step 11: 路由测试（`server/app.test.ts`）**

照 luts 那组（约 1134-1213 行）加：① 没登录 POST → **401 而不是 400**（先认人再读体）；
② `GET /api/presets/1/usage`（多一截）→ 404；③ 端到端：POST 存 → GET 列表里有它。

- [ ] **Step 12: 两绿 + 提交**

```bash
npm run typecheck && npx vitest run server/
git add server/db.ts server/db.test.ts server/presets.ts server/presets.test.ts server/app.ts server/app.test.ts shared/preset.ts
git commit -m "feat(预设·服务端): presets 表 + 四个动词 —— 骨架照 luts、不搬文件那三样"
```

---

### Task 2: 前端数据层

**Files:**
- Modify: `shared/preset.ts`（补 `PresetMeta` 已完成则跳过；这个任务其实只补缺的）
- Modify: `shared/copy.ts`（`PRESET_LIMIT_REACHED`）
- Create: `src/api/presets.ts`
- Create: `src/api/presets.test.ts`
- Create: `src/app/usePresets.ts`

**Interfaces:**
- Consumes: Task 1 的 HTTP 四个动词。
- Produces（Task 3/4/5 依赖）：
  - `shared/copy.ts`：`PRESET_LIMIT_REACHED(max: number): string`
  - `src/api/presets.ts`：`listPresets(): Promise<{presets: PresetMeta[]}>`、
    `createPreset(name: string, params: Adjustments): Promise<{preset: PresetMeta}>`、
    `renamePreset(id: number, name: string): Promise<{preset: PresetMeta}>`、
    `deletePreset(id: number): Promise<{ok: true}>`
  - `src/app/usePresets.ts`：`usePresets()` 返回
    `{ presets: PresetMeta[], known: boolean, refresh: () => Promise<void> }`
    —— `known` 的语义照 `lutsKnown`（"清单到手没有"和"你没有"是两件事）。

- [ ] **Step 1: `shared/copy.ts` 加一句**

照 `LUT_LIMIT_REACHED` 的形状与理由（函数 + 数字来自常量）：

```ts
/**
 * 预设到条数上限了（存那一行旁边那句）。
 * @param max 上限条数 —— 传 `MAX_PRESETS`。
 */
export const PRESET_LIMIT_REACHED = (max: number): string =>
  `最多 ${max} 套预设，先删掉一套再存。`
```

- [ ] **Step 2: 写 `src/api/presets.test.ts` 的失败测试**

照 `src/api/luts.test.ts` 的结构（如有；没有就照 `src/api/works.test.ts`）：
stub fetch，断言**方法和 URL** 与请求体形状（`POST /api/presets` 体是 `{name, params}`、
`PATCH /api/presets/3` 体是 `{name}`、`DELETE /api/presets/3`）。

- [ ] **Step 3: 跑红 → 实现 `src/api/presets.ts` → 跑绿**

实现照 `src/api/luts.ts` 的四函数（`get/post/patch/del` 都从 `./client` 拿）：

```ts
import { get, post, patch, del } from './client'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { PresetMeta } from '../../shared/preset.ts'

export async function listPresets(): Promise<{ presets: PresetMeta[] }> {
  return get<{ presets: PresetMeta[] }>('/api/presets')
}

export async function createPreset(name: string, params: Adjustments): Promise<{ preset: PresetMeta }> {
  return post<{ preset: PresetMeta }>('/api/presets', { name, params })
}

export async function renamePreset(id: number, name: string): Promise<{ preset: PresetMeta }> {
  return patch<{ preset: PresetMeta }>(`/api/presets/${id}`, { name })
}

export async function deletePreset(id: number): Promise<{ ok: true }> {
  return del<{ ok: true }>(`/api/presets/${id}`)
}
```

Run: `npx vitest run src/api/presets.test.ts` → PASS。

- [ ] **Step 4: 写 `src/app/usePresets.ts`**

形状对着 `src/app/useLuts.ts` 的**清单那一半**（不含缩略图）——先读它，把"加载/刷新/`known`"
那几行的结构搬过来，差异：

```ts
/** ★ 2026-10-10：「我的预设」的清单。缩略图不在这 —— 那是 `usePresetThumbs` 的活。 */
export function usePresets(): { presets: PresetMeta[]; known: boolean; refresh: () => Promise<void> }
```

- 首次挂载拉一次；`refresh` 供存/改/删之后重拉（或就地更新——**照 `useLuts` 里改名/删除
  之后怎么维护列表的做法**，别新发明一种）；
- 失败时 `console.error` + `known` 保持 false（界面那头会给"清单还没到手"的说法）。

- [ ] **Step 5: 两绿 + 提交**

```bash
npm run typecheck && npx vitest run src/api/ shared/
git add shared/copy.ts shared/preset.ts src/api/presets.ts src/api/presets.test.ts src/app/usePresets.ts
git commit -m "feat(预设·数据层): api 客户端 + usePresets + 上限那句（照 Lut 对应件）"
```

---

### Task 3: 存 / 管 UI（调色面板）

**Files:**
- Create: `src/ui/PresetManager.tsx`
- Create: `src/ui/PresetManager.test.tsx`（或并入 `App.adjust.test.tsx`——照该文件既有习惯）
- Modify: `src/ui/AdjustmentPanel.tsx`（头部加一颗「我的预设」+ 展开区）
- Modify: `src/App.tsx`（接线：`usePresets` + 传 props）
- Modify: `src/styles.css`（新类的样式，**放在调色面板那一段的邻居里**）

**Interfaces:**
- Consumes: Task 2 的 `usePresets` / `api/presets` / `PRESET_LIMIT_REACHED`。
- Produces（Task 4/6/5b 依赖）：`PresetManager` 组件（props 见 Step 3）。
  App 里持有 `usePresets()` 的清单，**Task 4 的预设栏和 Task 6 的详情页入口也从它拿**。

- [ ] **Step 1: 写失败测试（组件级或 App 级，照 `App.adjust.test.tsx` 现有习惯）**

按字面量钉这几条：

```ts
it('面板头有「我的预设」——点开就地展开，不是弹窗', ...)
it('存一套：填名字 → 点「存下来」→ POST /api/presets 体是 {name, params: 当前那套}', ...)
it('名字空着时「存下来」禁用（不留点了没反应的按钮）', ...)
it('列表里每一套有一颗铅笔一颗垃圾桶；点垃圾桶先就地确认「删了就找不回来了。」', ...)
it('改名：点铅笔就地变输入框（回车保存、Esc 取消，和全站同一套手势）', ...)
it('满 30 套：输入行禁用 + 那句「最多 30 套预设，先删掉一套再存。」', ...)
it('清单还没到手时说的是「还没到手」不是「还没有」', ...)
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/App.adjust.test.tsx`（或新建的测试文件）
Expected: FAIL —— 「我的预设」那颗按钮不存在。

- [ ] **Step 3: 实现 `src/ui/PresetManager.tsx`**

结构照 `LutSettings` 的**行**（列表 + 铅笔/垃圾桶 + 就地确认）与 `AdjustmentPanel` 的
**就地展开**（`refOpen` 那套：一个 `useState` 管开合、展开区是有条件渲染的兄弟块）。
Props（生产的确切形状）：

```ts
type Props = {
  presets: readonly PresetMeta[]
  /** 清单到手没有（照 `lutsKnown`：拿"还没到手"当"你没有"是说假话）。 */
  known: boolean
  /** 当前这套参数（存下来的就是它）。 */
  params: Adjustments
  onSave: (name: string, params: Adjustments) => Promise<void>
  onRename: (id: number, name: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
}
```

- 顶部一行：`<input placeholder="给这套起个名…" maxLength={30}>` + `<Btn>存下来</Btn>`；
  名字 trim 后为空 → `disabled`；`presets.length >= MAX_PRESETS` → 禁用 + 那句文案；
  保存成功清空输入框（失败保留——用户不用重打）。
- 列表：每条`名字` + 铅笔（复用 `kit/RenameInput`，手势与全站一致）+ 垃圾桶（就地确认：
  「删了就找不回来了。」+`确认删除`/`算了`——**逐字抄** `LutSettings` 那条确认块的文案）。
- 空态：「还没有存过预设。」；未到手：「正在取…」（照 `LutSettings` 四态）。

- [ ] **Step 4: 接线（`AdjustmentPanel.tsx` + `App.tsx`）**

- `AdjustmentPanel` 的 `.panel-head`（约 215-218 行）加一颗：
  `<button className="presets-mine" aria-expanded={mineOpen} onClick={…}>我的预设</button>`
  —— ⚠️ 开合 state 和其他面板 state 一样放组件内（照 `lutOpen`）；展开区放在
  `.panel-head` 和「照着这张调」之间。
- `App.tsx`：`const presetsApi = usePresets()`；把 `presets`/`known`/`params` 与三个
  回调（内部调 `api/presets` 的四个函数 + `presetsApi.refresh()`）传进 `AdjustmentPanel`。
  **三个回调的失败要把服务端的话翻出来**（`errorText`），并让 PresetManager 就地说一句
  （照 `LutSettings` 的失败行）。

- [ ] **Step 5: 样式（`src/styles.css`）**

新类 `.presets-mine` / `.my-presets` / `.my-presets-row` 等：形状照 `.presets-ref` /
`.presets-source`（就地展开那些既有类）——**照抄它们的骨架、换名字**，别发明新形状；
字号只许走 `styles.ruler.test.ts` 那 9 档、字重只许 400/600。

- [ ] **Step 6: 跑绿 + 三样自查**

Run: `npx vitest run src/App.adjust.test.tsx src/styles.ruler.test.ts && npm run typecheck`
（ruler 守卫会当场红——如果字号/字重越界。）

- [ ] **Step 7: 提交**

```bash
git add src/ui/PresetManager.tsx src/ui/PresetManager.test.tsx src/ui/AdjustmentPanel.tsx src/App.tsx src/styles.css
git commit -m "feat(预设·存与管): 面板头「我的预设」——存/改名/删就地展开"
```

---

### Task 4: 用（预设栏）

**Files:**
- Modify: `src/ui/PresetRail.tsx`（加「我的预设」分区）
- Modify: `src/app/usePresetThumbs.ts`（循环扩到 `[...PRESETS, ...mine]`）
- Modify: `src/core/presets.ts`（`activePresetId` 加第三个参数）
- Modify: `src/App.tsx`（rail 接线）
- Modify: `src/ui/PresetRail.test.tsx` / `src/App.adjust.test.tsx`（新断言）

**Interfaces:**
- Consumes: Task 2 的 `PresetMeta`；Task 3 在 App 里已持有的清单。
- Produces: `activePresetId(a: Adjustments, lutOn: boolean, mine: readonly Preset[]): string | null`；
  `usePresetThumbs({ image, cube, mine })`。

- [ ] **Step 1: 写失败测试**

```ts
it('栏里多了「我的预设」分区：存过的那套出现在里面（格子 + 名字）', ...)
it('一套都没有时整个分区不画（现有版面零变化）', ...)
it('点我的那格 = 整套参数赋上去（和内置预设同一条路）', ...)
it('点完之后那一格是亮的（activePresetId 全等，跨内置/我的同一套判据）', ...)
it('删掉一套之后栏里那格跟着消失', ...)
```

- [ ] **Step 2: 跑红 → 实现**

- `usePresetThumbs`：入参加 `mine: readonly Preset[]`；`for (const preset of [...PRESETS, ...mine])`；
  依赖数组加 `mine`（注释里说明：存/删一套那一刻要跟着长/消，**但拖滑块照旧不重画**）。
- `PresetRail`：props 加 `mine: readonly Preset[]`；在现有 grid **之后**：
  `{mine.length > 0 && (<><div className="rail-head">我的预设</div><div className="rail-grid">…同款 rail-tile…</div></>)}`。
- `core/presets.ts`：`activePresetId(a, lutOn, mine = [])`——`PRESETS.find` 改成
  `[...PRESETS, ...mine].find`（默认值保旧调用不红）；注释补一句 id 空间的约定：
  内置 id 都是非纯数字串，服务端 id 转 `String(id)` 拼进来不会撞。
- `App.tsx`：`<PresetRail mine={myPresets.map(p => ({ id: String(p.id), label: p.name, adjustments: p.params }))} …>`
  —— ⚠️ **转换结果的引用要稳**（用 `useMemo` 包）：它在 `usePresetThumbs` 的依赖数组里，
  每次渲染新数组 = 每次渲染重画十三张缩略图。
  （`Preset` 类型从 `core/presets.ts` 来；这里的 `Preset` 形状就是 `{id, label, adjustments}`。）

- [ ] **Step 3: 跑绿 + `npm run typecheck`**

- [ ] **Step 4: 提交**

```bash
git add src/ui/PresetRail.tsx src/app/usePresetThumbs.ts src/core/presets.ts src/App.tsx src/ui/PresetRail.test.tsx src/App.adjust.test.tsx
git commit -m "feat(预设·用): 预设栏加「我的预设」分区 —— 缩略图与点亮全走既有那套"
```

---

### Task 5a: 对话那条——协议与服务端

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `server/route.ts`
- Modify: `server/validate.ts`
- Modify: `server/prompt.ts`
- Modify: `server/route.test.ts` / `server/validate.test.ts` / `server/prompt.test.ts`
- Modify: `scripts/check-lut.ts`（`FakeDecision` 本地类型跟一手）、`scripts/dump-copy.mjs`、
  `scripts/check-mobile-layout.mjs`（那两处是裸 JSON，跟一手）

**Interfaces:**
- Consumes: Task 1 的 `shared/preset.ts`（`samePresetName`）。
- Produces：
  - `shared/protocol.ts`：`PresetDecision = { name: string }`；`RouteDecision.preset: PresetDecision | null`（**必填**）；`RouteRequest.presets?: { name: string; params: Adjustments }[]`
  - `server/route.ts`：`normalizePresetList`；`parseDecision(content, text, lutNames, presetNames)`
  - `server/validate.ts`：`normalizePresetChoice`
  - `server/prompt.ts`：ROUTER_SYSTEM 预设段 + `buildRouterUser` 清单行

- [ ] **Step 1: 协议（`shared/protocol.ts`）**

照 `LutDecision`（12-18 行）与 `RouteDecision.lut`（34-35 行）的注释风格：

```ts
/**
 * 模型对**用户预设**的决定（★ 2026-10-10）。
 *   · `null` = 这次不碰预设（默认）
 *   · 有名字 = 套上那一套（整组参数赋值 —— 没有"强度"这回事，所以只有名字）
 */
export type PresetDecision = { name: string }
```

`RouteDecision` 加 `preset: PresetDecision | null`（**必填**，注释照 lut 那条：
"必填 —— 新增字段就该逼每个构造点表态"）；`RouteRequest` 加
`presets?: { name: string; params: Adjustments }[]`（可选，注释写明"30 的截断在**服务端**做"）。

- [ ] **Step 2: 跑 typecheck 收红点**

Run: `npm run typecheck`
Expected: 红 5 处（就是当年加 lut 被逼的全部）：`server/validate.ts` 三个返回字面量、
`src/App.tsx` 的 onCard 调用、`src/test/appHarness.tsx` 的 `decision()`。
**前三处本任务修**（`preset: null` 起步，normalize 后再填）；后两处先在字面量里摆
`preset: null`（App/harness 的正式接线在 Task 5b）。

- [ ] **Step 3: 服务端校验（`server/validate.ts`）**

照 `normalizeLutChoice`（116-133 行）逐条对写 `normalizePresetChoice`：
键不在/明说 null → `{preset:null, dropped:false}`；非对象/没 name → `dropped:true`；
`names.find(n => samePresetName(n, name))` 命中→回**清单里的原名**、不命中→ `{preset:null, dropped:true}`。
`parseDecision` 五处接线（行号是当前实测）：签名加 `presetNames`（142 行）、
`presetKeyPresent`（仿 172）、`hasPreset`（仿 175）、degraded 表达式 `|| droppedPreset`（203）、
`reconcile(route, hasParams || hasLut || hasPreset, hasEdit)`（210）、cleanNoop 闸（242-244）与
付费降级闸（291）各加 `hasPreset`/`!droppedPreset`、三个返回字面量（254/306/399）填 `preset`。

- [ ] **Step 4: 服务端路由（`server/route.ts`）**

`parseRequest`（95-112 行）加 `presets: normalizePresetList(o.presets)`；`ParsedRouteRequest`
（90-93）出口加必填 `presets`；新写 `normalizePresetList`（仿 `normalizeLutList` 126-140）：
最多 `MAX_PRESETS` 条（**多余的静默截断**——设计 §6.1，请求可以伪造、不报错）、
名字 trim + 截 `MAX_PRESET_NAME`、空名丢、`params` 过 `clampAdjustments`；
第 54 行 `parseDecision(content, req.text, req.luts.map(…), req.presets.map((p) => p.name))`。

- [ ] **Step 5: 提示词（`server/prompt.ts`）**

`ROUTER_SYSTEM`：JSON 模板（93 行那行旁边）加 `"preset": {"name": ""} | null`；
规则段（118-126 行那一段之后）加一节，**照 Lut 段的句式**：

- 「用户让你用**他自己保存的预设**时，从下面给他的预设清单里**照抄名字**，写进 preset：
  `{"name": "黄昏旅拍"}`。」
- 「这次不涉及预设 → `"preset": null`。**清单里没有的名字一个字都不许写。**」
- 「套预设和调色一样是**本地动作**，不算生成：route 照旧给 params。」
- 「预设和 Lut 是两回事：预设是参数、Lut 是滤镜，用户说的是哪个就回哪个字段。」

`buildRouterUser`（145-162 行）：照 `lutLines`（149-152 行）加预设清单行
（**名字 + 参数**都给，格式：`用户保存的调色预设有：「黄昏旅拍」= {对比度 +12, …}；…`）。

- [ ] **Step 6: 测试三件**

- `server/validate.test.ts`：照「滤镜决策」组（279-398 行）加「预设决策」组 —— 必含
  "名字不在清单 → null + degraded"、"大小写空格对号"、"没给清单不认任何名字"；
- `server/route.test.ts`：照 304-373 行加"清单进消息 / 端到端对号 + 清单外归 null + degraded"、
  **加一条 40 套 → 发给模型的只有 30 套**（不是 30 就红）；
- `server/prompt.test.ts`：照 126-132 / 199-206 行，按**字面量**钉新段的关键句和清单行。

- [ ] **Step 7: 两绿 + 提交**

```bash
npm run typecheck && npx vitest run server/
git add shared/protocol.ts server/route.ts server/validate.ts server/prompt.ts server/*.test.ts scripts/
git commit -m "feat(预设·对话服务端): 协议 + 校验 + 提示词 —— 和 Lut 完全平行的那条线"
```

---

### Task 5b: 对话那条——前端落地（★ 合流 nextParams）

**Files:**
- Modify: `src/app/useGeneration.ts`（`GenerationDeps` 加 `myPresets`；`applyDecision` 两处）
- Modify: `src/App.tsx`（`postRoute` 加 `presets:`；`useGeneration({...})` 传 `myPresets`）
- Modify: `src/test/appHarness.tsx`（`decision()` 的 `preset: null` 已在 5a 摆过，这里核一遍）
- Modify: `src/App.test.tsx`（端到端）

**Interfaces:**
- Consumes: 5a 的协议；Task 2 的 `usePresets`；Task 3 在 App 里已持有的清单。
- Produces: 无新接口（行为落地）。

- [ ] **Step 1: 写失败测试（`src/App.test.tsx`）**

```ts
it('★ 说「用我那套X」：整套参数赋上去（和手点预设栏同一条路）', ...)
it('★ 套预设 + 生成同一次决策：**快照记的是套完之后的那套参数**（缩略图与主画面一致）', ...)
  // 这条是本任务存在的理由（设计 §6.3）：断 lastReply 出图之后，
  // 时间轴那格的缩略图与 canvasProps 最后一套 params 相等
it('模型给的名字不在清单里：不动状态（参数一个字节没变）', ...)
it('「用我那套X，再亮一点」：预设打底、增量叠上去', ...)
```

- [ ] **Step 2: 跑红 → 实现**

`src/app/useGeneration.ts`：

- `GenerationDeps` 加 `myPresets: Preset[]`（**前端形态**：`{id: string, label, adjustments}`——
  和 `core/presets.ts` 的 `Preset` 同一个类型；App 传的就是 Task 4 里 `useMemo` 过的那个数组）；
- `applyDecision` 的 **458-461 行那一段**（算 `nextParams`）按设计 §6.3 改写：

```ts
// ★ 2026-10-10（预设）：**合流**——不许像 lut 那样另开一块 setParams。
//   快照（缩略图 / 「回到这一步」）读的就是下面这个 nextParams（563 行传给
//   runGenerate）——另开一块会让它记的还是旧值，缩略图和主画面对不上（T8 那类）。
const hit = d.preset ? myPresets.find(p => samePresetName(p.label, d.preset!.name)) : null
if (d.preset && !hit) console.warn('模型给了一个不在清单里的预设名：', d.preset.name)
const base = hit ? hit.adjustments : params
const nextParams = (d.route === 'params' || d.route === 'both' || hit)
  ? applyDeltas(base, d.paramDeltas)
  : params
if (nextParams !== params) setParams(nextParams)
```

（`samePresetName` 比的是**名字**：`Preset.label` 是名字、`PresetDecision.name` 是名字。）
依赖数组（583 行）加 `myPresets`。

`src/App.tsx`：

- `send` 的 `postRoute`（1316-1320 行）加
  `presets: myPresets.map(p => ({ name: p.label, params: p.adjustments }))`，依赖数组（1357 行）加它；
- `useGeneration({...})`（722-739 行）传 `myPresets`。

- [ ] **Step 3: 跑绿 + `npm run typecheck`**

- [ ] **Step 4: 提交**

```bash
git add src/app/useGeneration.ts src/App.tsx src/test/appHarness.tsx src/App.test.tsx
git commit -m "feat(预设·对话前端): 「用我那套X」整套赋值 —— 合流进 nextParams（快照才不错）"
```

---

### Task 6: 作品详情页的「把这套存成预设」

**Files:**
- Modify: `src/ui/WorkDetailPage.tsx`（配方那栏加一颗）
- Modify: `src/App.gallery.test.tsx`（新断言）

**Interfaces:**
- Consumes: Task 2 的 `createPreset`；Task 3 的存组件（**最大化复用**——详情页这颗
  点开后的"起名 + 存"就是复用 PresetManager 里那段，别抄第二份）。

- [ ] **Step 1: 写失败测试**

```ts
it('配方那栏有「把这套存成预设」：点了就地展开起名那一行', ...)
it('存下来的是**这份配方的 params**（不是当前修图那套 —— 用户看的正是这份）', ...)
```

- [ ] **Step 2: 跑红 → 实现 → 跑绿**

实现要点：按钮放在「这张图怎么来的」那一栏的头部（和「套用到我正在改的图」并排）；
展开区复用 PresetManager 的"起名 + 存"子块——**如果复用不了就把 PresetManager 里的那一段
抽成一个小导出组件**（不许复制粘贴第二份，评测会挑）。

- [ ] **Step 3: 提交**

```bash
git add src/ui/WorkDetailPage.tsx src/App.gallery.test.tsx
git commit -m "feat(预设·详情页): 「把这套存成预设」——停在配方上的一键保存"
```

---

### Task 7: 真机验收 + 收尾

**Files:**
- Create: `.superpowers/scratch/verify-presets.mjs`（一次性探针，**不入库**）
- Modify: `docs/文案规范.md`（新词条：「我的预设」进那张"同一件东西只有一个名字"的表）

- [ ] **Step 1: 起 dev + 探针**

照 `verify-2026-10-10.mjs` 的骨架（注册临时账号 + 拦截 `/api/route` 与 `/api/suggest`）。
断言清单：

```text
① 面板头那颗「我的预设」在；点开是就地展开（不弹窗）
② 填名 → 存下来 → 预设栏出现「我的预设」分区 + 新格（缩略图是**当前照片**画的，有像素）
③ 点那格 → 参数整组变成预设那套（对几个滑块值）、那格点亮
④ 对话说「用我那套X」→ 参数变；**出图后缩略图与主画面同一套颜色**（⑥ 的靶心）
⑤ 改名 → 栏里名字跟着变；删除 → 栏里那格消失；**删正在用的：画面不变**
⑥ 40 套 > 30（脚本直接走 API 造）→ 界面上 40 套都在、发给模型的截到 30（看请求体）
⑦ 详情页「把这套存成预设」全流程
```

- [ ] **Step 2: 文案通读**

Run: `npm run check:copy`（对着 `docs/文案规范.md` 通读新增的每一句）。

- [ ] **Step 3: 全量 + 收尾提交**

```bash
npm test && npm run typecheck
git add docs/文案规范.md
git commit -m "docs(文案): 「我的预设」进名字表 + 真机验收记录"
```

---

## 自检记录（写完计划后对着 spec 过的）

- **Spec 覆盖**：§2 数据层 → Task 1；§3 接口 → Task 1；§4 前端数据层 → Task 2；
  §5.1 存/管 → Task 3；§5.2 用 → Task 4；§5.4 详情页 → Task 6；§6 对话 → Task 5a/5b；
  §7 的 19 个改动点逐条落在 Task 1-6（探针/夹具那条在 5a 里点名）；
  §8 验收 → Task 7。**无缺口**。
- **占位符扫描**：无 TBD/TODO；"照 X 抄"的都给了**精确出处 + 差异清单**（不是"类似某任务"）。
- **类型一致性**：`PresetMeta{id:number,name,params,createdAt}`（服务端/前端数据层）与
  `Preset{id:string,label,adjustments}`（UI 层，Task 4 映射）分界清楚；`samePresetName`
  在服务端比 `name`、在前端比 `Preset.label`——两处都点明了比的是同一个"名字"。
