# 「我的预设」落地设计（2026-10-10）

> **需求来源**：`2026-09-24-accounts-and-gallery-design.md` §8.1（存/用/名）、§8.3（呈现）、
> §9 的四条定案（三处都能用 / 发给模型最多 30 / 常驻只占一个按钮 / 用当前照片的缩略图）。
> 本文是**落地方案 + 对其中过时处的更正**：§8.1 写于 09-24，之后 LUT、预设栏、专业面板、
> 账本、App 拆分都落了地，几处呈现与协议需要修正（见 §1）。

---

## 0. 一句话

用户把**当前那 15 个调色参数**存成一套有名字的预设；在**预设栏**（照片左边那排小图）
点一下就用；在**对话**里说「用我那套黄昏的」也能用；在调色面板里**存 / 改名 / 删**。

⚠️ **它只存 15 个参数，不含 Lut**（§9）——「一次旅行一套色」指的是调色那套；
滤镜是另一个资源（`LutRef` 挂在版上、有自己的强度和删除语义，塞进来是另一个工程）。

---

## 1. 对 spec §8.1/§8.3 的三处更正（先摆明白，别照着老稿做）

| 老稿怎么说 | 更正 | 为什么 |
|---|---|---|
| §8.3：常驻一个按钮「[我的预设 ▾]」→ 点开一个**浮层**、里面是缩略图网格 | **不做浮层**。「我的」直接进**预设栏**（`ui/PresetRail`，2026-10-05 落地的那条竖栏，已经是"用当前照片渲染的小图"） | 浮层方案写于预设栏存在之前；今天那条栏就是这件事的答案（同一功能两处呈现 = 用户会看到两次一样的名字）。"常驻只占一个按钮"的精神由栏里**一格**来满足 |
| §8.1：「协议不用改 —— 模型看到『黄昏 = {亮度 -10…}』，用户说"用黄昏那套"，它**直接回那套数字**就行」 | **协议要改**。改成与 Lut **完全平行**：清单（名字 + 参数）送上去、模型**只回名字**、前端自己赋值 | 模型的输出通道是**增量**（`paramDeltas`，±100 的差值）且要逐键钳制；让模型"回那套数字"（绝对值 = 另一套语义）是在同一字段里混两种东西，算不准也验不了。Lut 那条线（只回名字、前端对号）已经跑通，照它 |
| §9：「发给模型最多 30；超出的界面上仍然能用」 | 存储上限**也是 30**（`MAX_PRESETS = 30`，对称 `MAX_LUTS`）——"超出的界面上仍能用"这一格自然满足；协议层**仍然写 30 的截断**（一行防御，将来上调上限时它是对的） | 个人用户 30 套够用（12 内置 + 30 自己）；两个数字来自同一个常量，不会漂 |

---

## 2. 数据层

### 2.1 表（迁移第 7 条，追加在 `server/db.ts` 的 MIGRATIONS 末尾）

```sql
CREATE TABLE presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL COLLATE NOCASE,
  params     TEXT    NOT NULL,        -- 15 个参数的 JSON（clamp 之后）
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX presets_user ON presets(user_id);
```

- `UNIQUE(user_id, name)` + `COLLATE NOCASE` 照 `luts` 的设计（重名不许、忽略大小写）。
- `ON DELETE CASCADE`：注销时行随 `users` 级联走，**`handleDeleteAccount` 一个字不用动**
  （那里手动收的是**文件**；预设没有文件）。
- ⚠️ **迁移指纹**：`server/db.test.ts` 的 `PINNED_MIGRATIONS` 要**追加一条**（只追加、不重生成整份，
  那条注释点名了这是训练坏习惯）。不让补的话 `length` 断言会红一次 —— 那是有意的信号。
- ⚠️ **不进 5 GB 配额**：`storedBytes()` 是逐表写死的三句 SUM（works/sessions/luts），
  预设是纯 JSON、不占共享盘，配额存在的理由（防一个人把盘写满）跟它无关。
  防滥用走**条数上限**（照 luts）。**别**给它加 `bytes` 列去凑数。

### 2.2 上限与名字（全照 Lut）

- `MAX_PRESETS = 30`、名字 1–30 字、重名不许（忽略大小写）。
- 都放 **`shared/preset.ts`**（前后端共用，照 `shared/lut.ts` 的形状：
  `presetNameOk` / `samePresetName`）。

---

## 3. 接口（四个动词，形状照 `/api/luts`）

| 路由 | 干什么 |
|---|---|
| `GET /api/presets` | 列表（`{ presets: PresetMeta[] }`，按 created_at 倒序） |
| `POST /api/presets` | 存一套：`{ name, params }`（服务端 clamp 后入库）→ `{ preset }` |
| `PATCH /api/presets/:id` | 改名：`{ name }` → `{ preset }` |
| `DELETE /api/presets/:id` | 删 → `{ ok: true }` |

- **没有** luts 那条 `/file`（预设没有文件）和 `/usage`（预设不被任何东西引用 ——
  应用预设是"把参数赋值过去"，会话里存的是那份参数本身，删预设不影响老会话）。
- `presetDeps = { db, now }`，**不需要 storage**。
- **不加限流闸**：`luts` 的 CRUD 一处都没走闸；闸的语义是"这次调用花真钱"（预设不花钱）。
- 错误照全站：`throw new HttpError(...)`；先认人（`requireUser`）再读体。

---

## 4. 前端数据层

| 文件 | 内容 |
|---|---|
| `shared/preset.ts`（新） | `PresetMeta = { id: number; name: string; params: Adjustments; createdAt: number }`；`MAX_PRESETS`；`presetNameOk`；`samePresetName` |
| `src/api/presets.ts`（新） | `listPresets` / `createPreset` / `renamePreset` / `deletePreset` —— 照 `src/api/luts.ts` 的四函数形状 |
| `src/app/usePresets.ts`（新） | 清单 state + CRUD 包装 + "清单到手没有"（照 `lutsKnown` 那条四态教训）——形状对着 `useLuts` 写，但**不含缩略图**（缩略图在 `usePresetThumbs`） |
| `shared/copy.ts` | 新增 `PRESET_LIMIT_REACHED(max)`（照 `LUT_LIMIT_REACHED` 的形状与理由：数字必须来自常量） |

---

## 5. UI

### 5.1 存 / 管（调色面板头）

`.panel-head` 从 `[调色] [重置]` 变成 `[调色] [我的预设] [重置]`。
点「我的预设」**就地展开**一块（不弹窗，全站规矩）：

```
┌────────────────────────────────────┐
│ [ 给这套起个名…        ] [ 存下来 ] │   ← 存：名字空着时「存下来」禁用
│ ────────────────────────────────── │
│ 黄昏旅拍                    ✎  🗑  │   ← 每条：名字 + 就地改名 + 就地确认删除
│ 清透日系                    ✎  🗑  │
└────────────────────────────────────┘
```

- **空态**：只有存那一行 + 一句「还没有存过预设。」（照四态的教训：不拿"还没到手"当"没有"）。
- **满额**：输入行禁用 + `PRESET_LIMIT_REACHED` 那句。
- **重名**：服务端报错 → 就地一句（`errorText`）。
- 改名用 `kit/RenameInput`（全站同一套手势）；删除是**就地确认**（「删了就找不回来了。」，
  和 Lut 删除同一个形状 —— 但**没有**"用着它呢"那半：预设没有引用关系，见 §3）。
- 组件落点：`ui/PresetManager.tsx`（新），状态在 App 那侧（照 LutSettings 的分层）。

### 5.2 用（预设栏）

`PresetRail` 现有 grid（原图 + 12 内置）**之后**加一个分区：

```
[预设]
  [原图][日系通透][胶片] …
[我的预设]          ← 没有预设时**整个分区不画**（现有版面零变化）
  [黄昏旅拍][清透日系] …
```

- 同款 `.rail-tile` 格子、同款"用当前照片画的小图"。
- 缩略图：`usePresetThumbs` 加 `mine` 入参，循环从 `PRESETS` 扩成 `[...PRESETS, ...mine]`；
  依赖数组加 `mine`（存/删一套，那一格跟着长/消）。
- 点格子 = `setParams({ ...p.adjustments })`（和内置同一条路）。
- `activePresetId(a, lutOn)` 加第三个参数（我的预设清单），全等匹配的范围扩到"内置 + 我的"。
- **id 形状**：内置 id 是字符串（`'golden'`），服务端给的是数字 —— 转成 `String(id)` 拼进同一个空间
  （内置 id 全是非纯数字，不会撞）。

### 5.3 删掉正在用的那套

**画面不变**（参数已经赋进 `params` 了，独立存活）——和 Lut 不同（那边删了引用会被清 null）。
这就是 §3"没有 usage 检查"的产品侧理由，不需要任何特殊处理。

### 5.4 作品详情页的「把这套存成预设」（spec §8.1 点名的第二个存入口）

作品详情页的「配方」那一栏加一颗「把这套存成预设」：点了 → **就地展开**一行
「[ 起名 ] [存下来]」（复用 §5.1 的存组件）→ 存的是**这份配方的 `params`**。
（"看到调得好的一键存下来"—— spec §8.1 的原话。）

---

## 6. 对话那条（和 Lut 完全平行）

### 6.1 协议（`shared/protocol.ts`）

- 新增 `PresetDecision = { name: string }`；
- `RouteDecision` 加**必填** `preset: PresetDecision | null`（注释照 lut 那条：
  "必填 —— 新增字段就该逼每个构造点表态"；typecheck 会逼红 5 个构造点，是设计）；
- `RouteRequest` 加**可选** `presets?: { name: string; params: Adjustments }[]`
  （只给名字 + 参数；30 的截断在**服务端**做 —— 请求可以伪造，前端的截不算数）。

### 6.2 服务端

- `parseRequest` 加 `presets: normalizePresetList(o.presets)`（照 `normalizeLutList`：
  条数截 30、名字 trim + 截 30 字、空名丢、**params 过 `clampAdjustments`**—— 客户端来的数字必须钳）；
- `parseDecision(content, text, lutNames, presetNames)` 加清单参数；
- `normalizePresetChoice`（照 `normalizeLutChoice`）：不在清单里的名字 → 归 `null` + `dropped`； 
  命中 → 回**清单里的原名**；`dropped` 并进 degraded；三处"有没有实质动作"的闸门
  （cleanNoop / reconcile / 付费降级）都加 `hasPreset`/`!hasPreset`；
- `ROUTER_SYSTEM` 加一段（对照 Lut 段 118-126 的写法）：
  照抄名字 / "不用了"怎么写 / 清单没有的不许写 / **套预设是本地动作、不算生成（route 照旧给 params）** /
  回话里用界面上的名字；
- `buildRouterUser` 加一行清单：`用户保存的调色预设（名字 = 那套参数）有：黄昏、清透…`
  （**名字 + 参数**都给 —— spec §8.1 定的"20 个 ≈ 1000 tokens 可以接受"）。

### 6.3 前端落地 ★ 本节最要紧的契约

**预设赋值必须合流进 `useGeneration.ts` 算 `nextParams` 的那一段（458-461 行），
不许像 lut 那样在后面另开一块 `setParams`。**

为什么：快照（缩略图、「回到这一步」还原的主画面）读的就是同一个 `nextParams`
（它被传给 `runGenerate` → `pushSnapshot` 的 `params`）。另开一块的后果是
**`setParams` 被调两次、快照记的还是旧值** —— 缩略图和主画面对不上（T8 那类
"小图 vs 主画面不符"的历史 bug，注释在哪都写着）。

语义（**预设打底、同次决策的增量叠上去**）。

⚠️ 命名：那段代码里"我的预设清单"（deps 传进来的、带 id 的那种）**统一叫 `myPresets`**
—— 它和协议里的 `RouteRequest.presets`（发给模型的名字+参数）是两样东西，同名会绕：

```ts
const hit = d.preset ? myPresets.find(p => samePresetName(p.name, d.preset!.name)) : null
if (d.preset && !hit) console.warn('模型给了一个不在清单里的预设名：', d.preset.name)
const base = hit ? hit.params : params
const nextParams = (d.route === 'params' || d.route === 'both' || hit)
  ? applyDeltas(base, d.paramDeltas)
  : params
```

（"用我那套黄昏的" → 命中 + 增量为空 = 整套赋值；"用黄昏那套再亮一点" → 打底 + 叠加。
两者都是同一条式子。）

**不引入 `presetName` 状态**：点亮全靠 `activePresetId` 全等算出来 —— 和手点预设栏
**同一条路**（删掉正在用的那套画面也不变，见 §5.3）。

### 6.4 对不上清单时

服务端已经归 `null` + `degraded`（前端会看到"拿不太准"那句提醒）；前端再 `console.warn` 一道、
**不动任何状态**（照 lut 那条"宁可什么都不做，也别套一个用户没有的东西"）。

---

## 7. 改动点清单（给实现逐条打勾）

**服务端**
1. `server/db.ts`：MIGRATIONS 追加第 7 条；`server/db.test.ts` 的 `PINNED_MIGRATIONS` 追加指纹
2. `server/presets.ts`（新）：`PresetRow` / `listPresets` / `createPreset` / `renamePreset` /
   `deletePreset` / `loadOwnedPreset` / `assertNameFree`（照 luts.ts 的骨架，**不搬**文件 I/O、
   .cube 解析、引用清理那三样）
3. `server/app.ts`：`/api/presets` 四条路由（插在 luts 块之后）+ `presetDeps`
4. `server/route.ts`：`normalizePresetList` + 进出类型 + 名单传 parseDecision
5. `server/validate.ts`：`normalizePresetChoice` + parseDecision 五处接线（清单参数 / degraded /
   reconcile / 两道闸 / 三个返回字面量）
6. `server/prompt.ts`：ROUTER_SYSTEM 规则段 + buildRouterUser 清单行

**协议 / 前端数据**
7. `shared/protocol.ts`：`PresetDecision` + `RouteDecision.preset`（必填）+ `RouteRequest.presets?`
8. `shared/preset.ts`（新）+ `shared/copy.ts`（`PRESET_LIMIT_REACHED`）
9. `src/api/presets.ts`（新）+ `src/app/usePresets.ts`（新）

**UI**
10. `src/ui/PresetManager.tsx`（新：存/改名/删，就地展开）+ 面板头接线（AdjustmentPanel 加一颗）
11. `src/ui/PresetRail.tsx`：加「我的预设」分区 + `mine` 入参
12. `src/app/usePresetThumbs.ts`：循环扩到 `[...PRESETS, ...mine]` + 依赖加 `mine`
13. `src/core/presets.ts`：`activePresetId(a, lutOn, mine)` 第三个参数
14. `src/App.tsx`：`usePresets` 接线（rail / 面板 / postRoute 的 `presets:` / useGeneration 传清单）；
    `onCard` 字面量加 `preset: null`
15. `src/ui/WorkDetailPage.tsx`：配方那栏加「把这套存成预设」（§5.4）

**测试**
16. `src/test/appHarness.tsx`：`decision()` 加 `preset: null`（typecheck 逼红点）
17. 服务端：`server/db.test.ts`（迁移已含在 1）、`server/presets.test.ts`（新，照 luts.test.ts）、
    `server/app.test.ts`（路由 401 先于读体 / 正则锚定）、`server/validate.test.ts`（预设决策组）、
    `server/route.test.ts`（清单进消息 / 端到端对号 + 清单外归 null + degraded）、
    `server/prompt.test.ts`（钉措辞）
18. 前端：`usePresetThumbs` 的扩展、`PresetRail`/`PresetManager` 的组件测试、
    `App.*.test.tsx` 里对话那条端到端（说"用我那套X" → 参数变 + 生成时快照带的是预设参数）
19. 探针/夹具手动跟：`scripts/check-lut.ts` 的 `FakeDecision`（不会红但会过期）、
    `scripts/dump-copy.mjs` / `scripts/check-mobile-layout.mjs` 的裸 JSON（同上）

---

## 8. 验收

- `npm test` + `npm run typecheck` 两绿；
- **真机探针**（起 dev + 拦截 /api/route）：存一套 → 预设栏出现新格（缩略图有像素）→
  点它参数整组变 → 对话说「用我那套X」→ 参数变且生成成功时**缩略图和主画面同一套颜色**（§6.3 的靶心）→
  改名 → 删除（含删正在用的：画面不变）；
- 界面文案通读一遍（`npm run check:copy`）。

## 9. 明确不做

- **预设不含 Lut**（见开头那句）；
- ~~预设的分享 / 导出 / 导入~~ —— 2026-10-17 已补版本化 JSON 导入 / 导出，
  见 `2026-10-17-preset-import-export-design.md`；
- "当前用着哪套"的显式状态（§6.3 末段）；
- 作品详情页那颗之外的第三处存入口（对话里"把这套存下来"之类 —— 现在没有这个必要性）。
