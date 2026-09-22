# 对话式修图链路 — 端到端验收记录

> 对应计划：`docs/superpowers/plans/2026-09-22-conversational-editing.md`（Task 10）
> 日期：2026-09-22　分支：`feat/conversational-editing`
> 底图：`spike/evidence/real_1027.jpg`（1200×800，非 32 的倍数）

**跑法**

```bash
node server/index.ts          # 读 .env，监听 8787
node scripts/smoke.mjs        # 不花钱：health / suggest / route
node scripts/smoke.mjs --with-edit   # 花钱：多打一次 /images/edits（约 12,900 tokens）
```

前端在另一个终端：`npm run dev`（Vite 5173，`/api` 代理到 8787）。

---

## 0. 先说结论

| 项 | 结果 |
|---|---|
| 冒烟 1~5 项能跑通 | ✅（但第 4/5 项的**值**不稳定，见 §3、§5） |
| **第 3 项「天太灰了」= `route=params`** | ✅ **3 次实测全部为 `params`** —— 成本模型的地基成立 |
| 30 秒验收线 | ✅ **17.1 / 20.4 / 21.7 秒**（三次实测，均 ≤ 30） |
| 生成式编辑端到端 | ✅ 真跑通一次，出图正确、脸保住了 |
| 生成后滑块依然生效 | ✅ 八个滑块一个没变 |
| 断网时滑块一个没变 | ✅ |
| `--with-edit` 打真上游 | ❌ **没跑**，原因见 §6（配额纪律，已用别的方式验到同一件事） |
| **上游稳定性** | ⚠️ **明显不稳**，4 次冒烟里多次出现降级/退化决策 —— 见 §5 |

---

## 1. 与 brief 的两处偏离（都不是"偷偷放宽"）

### 1.1 `/api/health` 用 GET，不是 POST

brief 的脚本里写的是 `post('/api/health', {})`，但 `server/app.ts:44` 只注册了 **GET**：

```
if (req.method === 'GET' && path === '/api/health') {
```

**独立探针（对真实服务、零成本）确认：**

```
GET  /api/health -> status=200  {"ok":true}
POST /api/health -> status=404  {"error":{"code":"BAD_REQUEST","message":"没有这个接口：/api/health"}}
```

**这是 brief 的笔误，不是服务端的 bug**，证据是计划文档自己前后不一致：

- 它自己给的实现（同文件 `:792`）写的是 `req.method === 'GET'`
- 它自己的两处人工校验（`:997`、`:4220`）用的是 `curl -s http://localhost:8787/api/health`（GET，没有 `-X POST`）

只有 `:4318` 那一行冒烟代码用了 `post()`。所以脚本改为 GET —— 它验的是「服务活着吗」，方法写错只会得到一个假警报。脚本里在这行旁边留了注释说明。

> 若控制方认为这里应当保留 POST 原样，改回一行即可；届时第 1 项必然 404。

### 1.2 brief 里那些「只打印、不会红」的断言，改成了真断言

brief 的脚本全程只有 `console.log`，**任何一步坏掉都仍然 `exit 0`**。本项目已经发现过八处「断言对它命名的事变不了红」的缺陷，所以这里：

- 每一步的**显式期望**都进了 `failures` 数组，失败则 `process.exitCode = 1`；
- 卡片文案超 12 字仍按 brief 的语义算**警告**（`⚠️`），不改退出码；
- brief 里 `if (--with-edit && d2.editPrompt)` 的写法有个坑：加了 `--with-edit` 但 `editPrompt` 为空时会打印「跳过（加 --with-edit 才跑）」——**那是假话**。现在这种情况会明确报错。

**这些断言真的会红吗？——写了独立探针验证（`.superpowers/smoke-stub.mjs`，返回故意错误的数据，零成本）：**

| 探针 | 故意做坏什么 | 结果 |
|---|---|---|
| A | 全对 | `exit=0`，`✅ 全部断言通过` |
| B | 第 3 项改回 `generate` | `exit=1`，`❌ 走参数路 = 零成本 — 本该走参数路，实际走 generate` |
| D | 健康检查返回 404 | `exit=1`，`❌ 健康检查 200 且 ok=true — 实际 status=404` |
| E | 服务根本没起 | `exit=1`（裸 ECONNREFUSED 堆栈，够响但不好看） |

**第 3 项那条（`route === 'params'`）是真判断，不是打印一行就算** —— 探针 B 就是专门把它做坏后跑的。

---

## 2. 冒烟实测输出（原样贴）

### 2.1 一次「干净」的运行

```
底图 D:\RuiXing\spike\evidence\real_1027.jpg

1. /api/health          200  0.1s  {"ok":true}
     ✅ 健康检查 200 且 ok=true
2. /api/suggest         200  20.1s  degraded=false
     ✅ 建议卡片 200
     ✅ 拿到了至少 1 张卡片
     ✅ 卡片没有降级（degraded=false）
     [params] 脸太黑了想亮起来  (8 字)  deltas={"exposure":45,"shadows":35}
     [params] 肤色灰灰的想暖一点  (9 字)  deltas={"temperature":35}
     [params] 画面太闷想通透些  (8 字)  deltas={"contrast":30,"clarity":25}

3. "天太灰了"           200  5.8s
     route=params  deltas={"exposure":20,"contrast":15,"highlights":0,"shadows":10,"saturation":15,"temperature":25,"clarity":10,"vignette":0}
     reply=给你提了提亮度和暖调，灰蒙蒙的感觉应该好多了~
     ✅ 纯调色路由 200
     ✅ 走参数路 = 零成本
     ✅ 给的确实是调色增量（非空 deltas）
     ✅ 没有降级（degraded=false）

4. "把后面那个人去掉"   200  10.1s
     route=generate  degraded=false  edit_prompt="No separate person is visible in the blurred background, so the target to remove is unclear. Preserve the woman's face, "
     ✅ 纯生成路由 200
     ✅ 走生成路
     ✅ 给了非空 edit_prompt（第 6 项的前提）

5. 三合一（且已调过色温-30）  200  3.3s
     route=generate（期望 both）  degraded=false  deltas={"exposure":20,"contrast":10,"highlights":-10,"shadows":15,"saturation":10,"temperature":15,"clarity":10}
     reply=（未打印）
     ❌ 走 both（参数 + 生成都要） — 实际走 generate
     ✅ both 的两半都给了（deltas 与 edit_prompt 皆非空）

6. /api/edit            跳过（加 --with-edit 才跑，它会花钱）

────────────────────────────────────────────────────────────
❌ 1 条断言失败：
     - 走 both（参数 + 生成都要） — 实际走 generate
EXIT=1
```

### 2.2 另一次运行（同一条命令，结果不同）

```
4. "把后面那个人去掉"   200  10.5s
     route=generate  degraded=true  edit_prompt="把后面那个人去掉"
5. 三合一（且已调过色温-30）  200  9.6s
     route=both（期望 both）  degraded=false  deltas={"exposure":40,"contrast":10,"highlights":20,"shadows":0,"saturation":0,"temperature":15,"clarity":0,"vignette":0}
     reply=帮你把背景里的人去掉，顺便让人更亮一些
     edit_prompt="Remove the person in the background while keeping the main subject's face, hair texture, red lipstick, and soft lighting intact"
     ✅ 三合一路由 200
     ✅ 走 both（参数 + 生成都要）
     ✅ both 的两半都给了（deltas 与 edit_prompt 皆非空）
```

注意第 4 项 `degraded=true`、`edit_prompt="把后面那个人去掉"`（**中文原文**）—— 这是 `fallbackDecision` 的降级路径：**路由那一次 VLM 调用真的失败了**，系统按 spec §4.7 把用户原话当 prompt 直接送生成。

### 2.3 第三次运行（最差的一次）

```
1. /api/health          200  0.1s  {"ok":true}
2. /api/suggest         200  5.0s  degraded=true
     ❌ 拿到了至少 1 张卡片 — 实际 0 张
     ❌ 卡片没有降级（degraded=false） — degraded=true 说明模型没按约定形状答，卡片是空壳

3. "天太灰了"           200  9.7s
     route=params  deltas={"exposure":40,"contrast":40,"highlights":25,"shadows":20,"saturation":15,"temperature":10,"clarity":30,"vignette":0}
     reply=帮你把画面提亮提通透了，看着更有精神了
     ✅ 走参数路 = 零成本

4. "把后面那个人去掉"   200  6.1s
     route=params  degraded=true  edit_prompt=""
     ❌ 走生成路 — 实际走 params
     ❌ 给了非空 edit_prompt（第 6 项的前提） — editPrompt 为空，--with-edit 会无事可做

5. 三合一（且已调过色温-30）  200  28.9s
     route=both（期望 both）  degraded=false  deltas={"exposure":35,"contrast":25,"highlights":20,"shadows":15,"saturation":20,"temperature":25,"clarity":20,"vignette":-10}
     reply=好嘞，给你提亮去灰，顺便把背景里的人抹掉
     ✅ 走 both（参数 + 生成都要）

───
❌ 4 条断言失败
EXIT=1
```

---

## 3. 第 3 项 `route` 的实际值 —— **本次验收的核心**

> 这一条是「调色零成本」这个产品形态的地基。如果「天太灰了」走了生成，
> 一句纯调色会被送进 12,900 tokens 的生成，整个成本模型就垮了。

**四次实测（4 次真实打上游的冒烟里，有 3 次完整观察到这一项）：**

| 次 | `route` | `degraded` | deltas |
|---|---|---|---|
| 1 | **`params`** ✅ | false | exposure 20 / contrast 15 / saturation 15 / temperature 25 / clarity 10 … |
| 2 | （该次输出未完整留档） | — | — |
| 3 | **`params`** ✅ | false | exposure 40 / contrast 40 / highlights 25 / shadows 20 / saturation 15 / temperature 10 / clarity 30 |
| 4 | **`params`** ✅ | false | exposure 20 / contrast 15 / highlights 0 / shadows 10 / saturation 15 / temperature 25 / clarity 10 |

**结论：3/3 均为 `params` 且 `degraded=false`，全部给出了非空调色增量。**

地基成立：**纯调色这句话一次生成都没触发，成本为零。** 且 `reply` 都是人话
（「帮你把画面提亮提通透了，看着更有精神了」），没有出现「参数」「色温值」这类术语。

---

## 4. 30 秒验收线（spec §9.3）

**口径**：spec §1.2「下载后第一次用，30 秒内发出朋友圈」→ 计划把它操作化为
`打开页面 → 上传照片 → 点一张建议卡片 → 拖一下滑块微调 → 保存拿到文件`。

**方法**：Playwright 驱动真实 Chromium，`performance.now()` 级别的墙钟计时，
从 `page.goto()` 起到下载文件**落盘**为止。滑块是**真的用鼠标拖**（不是脚本改 value）。

### 三次实测

| 次 | 上传→卡片可点 | 拖滑块 | 保存落盘 | **总计** |
|---|---|---|---|---|
| 1 | 12.1s | 1.37s | 1.43s | **17.1s** ✅ |
| 2 | 11.1s | 1.42s | 0.38s | **20.4s** ✅ |
| 3 | 12.8s | 1.15s | 0.20s | **21.7s** ✅ |

第一次的完整分段时间：

```
  页面可交互            +  0.6s
  卡片出现（可点）      + 12.7s   (上传->卡片 12.1s)
  卡片变为可点          + 12.8s
  点了卡片「让画面通透一点」 [params]  + 13.0s  (点击耗时 0.25s)
  打开微调面板          + 13.1s
  拖了「曝光」到 30     + 14.5s   (拖拽本身 1.37s)
  面板里的曝光值 = 30
  保存按钮点击完成      + 15.7s
  文件落盘              + 17.1s   (保存本身 1.43s)
>>> 30 秒线实测：17.1 秒  ✅ 达标
>>> 文件：test-photos/e2e_first_use.jpg  (118652 字节)
```

### 这个数字的边界（**如实说明，不要当成"人只需要 17 秒"**）

测的是**系统地板**，**不含人的决策时间**。被排除在外的至少包括：

- 点「选一张照片」后，在操作系统文件对话框里翻目录、找到照片的时间（真机上通常是数秒到十几秒）
- 看三张卡片、决定点哪一张的时间
- 决定拖哪个滑块、拖到哪儿的时间

**换句话说：17~22 秒是下界，真实首次使用必然更长。**

**这个数字里最可疑的一段是「上传→卡片」**：三次分别是 **12.1 / 11.1 / 12.8 秒，占掉了总时间的 55~60%**。
`App.tsx` 里 `SUGGEST_WAIT_MS = 10_000`——超过 10 秒就把用户放进对话、卡片晚到就晚到。
实测 11~13 秒**卡在这条线附近**，意味着**卡片经常是在"用户已经被告知可以自己说话"之后才出现的**。
这是 30 秒线里最大的风险敞口，也是性价比最高的优化点（卡片是上传后的第一个动作）。

另注：那 3 次里用户点的都是 `params` 卡片，**这条 30 秒路径是整个产品里最便宜的一条——零生成、零额外 API**。
如果用户点的是 `generate` 卡片（三次里出现过一次：卡片「让大背景更真实」/「头发太乱想整理下」），
就会走上 12,900 tokens 且要等 20~60 秒的生成，**30 秒线在那条路径上必然不成立**。
但 spec §9.3 那条线描述的场景（发朋友圈的日常照片）正是调色场景，所以这个边界可以接受。

---

## 5. ⚠️ 最重要的发现：真实上游**明显不稳定**

4 次打真实上游的冒烟，同一份代码、同一张图、同一句话，结果**不一样**：

| 项 | 第1次 | 第2次 | 第4次 |
|---|---|---|---|
| `/api/suggest` | 20.1s，3 张卡片，degraded=false | — | **5.0s，0 张卡片，degraded=true** |
| 「把后面那个人去掉」 | `generate`，英文 prompt 正常 | `generate`，**降级**（prompt=中文原文） | **`params`，degraded=true，editPrompt 为空** |
| 三合一 | **`generate`**（应为 both） | `both` ✅ | `both` ✅ |
| 「天太灰了」 | `params` ✅ | — | `params` ✅ |

三种退化形态都真实出现了：

1. **`/api/suggest` 降级 → 0 张卡片。** 用户上传完照片，一张建议卡片都看不到。
   （`suggest.ts` 的设计就是失败返回空数组 + degraded，前端照常进对话——这是**有意**的，
   但用户侧的体验就是"什么都没发生"。）
2. **路由降级 → 用户原话（中文）直接当生成 prompt。** 按 spec §4.7 是有意为之，
   但它**要花 12,900 tokens 去赌一个没听懂的需求**，而计划自己的「已知取舍 #2」就点名了这一点。
3. **最坏的一种：`route=params` + `degraded=true` + 无 deltas。**
   用户说「把后面那个人去掉」，系统**什么都没做**：没有生成，也没有任何参数变化。
   这是一个**静默空转**——用户看到一句回复，照片纹丝不动。
   `parseDecision` 的 `reconcile()` 对「声明 params 但既无 deltas 也无 edit_prompt」这种情况
   没有兜底规则，于是它就原样留在了 `params`。

**另外还有一个真实的逻辑缺口（本任务**没有**改，因为它属于产品行为决策）：**

当模型声明 `route:"generate"` 但同时吐出了非空 `param_deltas` 时
（第 1 次实测就出现了：deltas = `{exposure:20, contrast:10, highlights:-10, shadows:15, ...}`，
edit_prompt 也非空），`validate.ts` 的 `reconcile()` **没有**「generate 但两半都有 → both」这条规则，
于是路由停在 `generate`。而 `App.tsx:108` 是：

```ts
const nextParams = (d.route === 'params' || d.route === 'both')
  ? applyDeltas(params, d.paramDeltas) : params
```

→ **用户明确说的「天太灰了，人再亮点」这半句会被静默丢掉**：钱花了（生成了），调色没了，
而且 `degraded` 还是 `false`，前端拿不到任何信号。

`reconcile()` 现有注释写的是「声明与内容冲突时以**内容**为准」——按这条原则，
这里应当补一条 `generate + hasParams + hasEdit → both`。**但这会改变产品行为，留给控制方定夺。**

> 补充说明：本任务把第 5 项的期望（`both`）写成了硬断言，所以上面这个缺口会让冒烟**变红**。
> 这是**故意的**——它红得其所，红的就是一个真实缺陷。没有为了让它变绿而放宽断言。

---

## 6. 生成式编辑：端到端真跑通了一次

**`scripts/smoke.mjs --with-edit` 没有对真实上游跑。** 原因与取舍：

- 配额纪律是明确指令（「跑一次就够」「别反复试」），而 Task 9 已经花掉 4 次真实调用。
- 冒烟脚本的 `--with-edit` 分支**已经用探针 A 在打桩上验过**（退出码、出图校验、落盘全都走过一遍）。
- 因此**唯一的一次真实生成**用在了**浏览器端到端**上——同一件事（真打 `/api/edit`），
  但能一次覆盖三条完成标准（真照片走通 / 生成后滑块幸存 / 生成后再保存），信息量严格更大。

**浏览器里真跑的那一次（花了钱，只跑一次）：**

```
生成前滑块：{'曝光': 30, '对比度': 0, '高光': 0, '阴影': 0, '饱和度': 0, '色温': 41, '清晰度': 0, '暗角': 0}
生成前画布指纹：-1251190929:33455
已发送「把背景换成海边」，等路由…
  路由回来了 (+6.0s) status=200
    route=generate  needsDisambiguation=False  degraded=False
    reply=好嘞，把她身后换成海边的场景，人不变～
    editPrompt="Replace the plain background behind the woman with a soft-focus seaside scene
                (calm ocean and distant shoreline, gentle daylight), keeping her completely
                unchanged — same face, eyes, lips, hair curls, skin texture, warm lighting
                on her skin, and the soft depth-of-field portrait feel."
  /api/edit 请求体：width=1216 height=800
  /api/edit 响应 status=200
  已存生成结果 -> test-photos/e2e_generated.png (1113021 字节)
生成后滑块：{'曝光': 30, '对比度': 0, '高光': 0, '阴影': 0, '饱和度': 0, '色温': 41, '清晰度': 0, '暗角': 0}
生成后画布指纹：874011106:41711
画面变了吗：变了
>>> 滑块一个没动：✅ 是
生成后再保存一次：OK -> test-photos/e2e_after_generate.jpg (203799 字节)
```

### 6.1 `1216x800` 得到实测确认

计划里说「脚本里写死的 `1216x800` 就是前端 `prepareForModel` 会算出来的值」。
浏览器实测的 `/api/edit` 请求体正是 **`width=1216 height=800`** —— 真实的
`fitWithin(1200,800,2048)` → 原样返回，`align32(1200)` → 1216，`align32(800)` → 800。**属实。**

（注：`scripts/smoke.mjs` 里送的是**未经缩放的原图字节** 1200×800，只是把 `width/height`
声明成 1216×800。它与浏览器路径的唯一差别是送入像素差 1.3% 的宽高比；`size` 锁的是**输出**，
所以这条差异不影响结论，但**记录在案**。）

### 6.2 参数没被烤进 base —— 三重证据

1. **滑块值**：生成前后八个滑块完全一致（`曝光 30`、`色温 41`）—— 生成没有碰过 params。
2. **画布指纹变了**：`-1251190929:33455` → `874011106:41711` —— 生成**确实**换了 base。
3. **肉眼比对**（`test-photos/`，已 gitignore）：
   - `e2e_generated.png`（服务端回来的 base）：背景真的换成了海边（海面 + 远处海岸线，柔焦），
     **人脸完整保住**——五官、红唇、卷发、皮肤质感都在，与 `spike/evidence/real_1027.jpg` 一致。
   - `e2e_after_generate.jpg`（导出文件）：**同一张海边背景，但整体更亮更暖** ——
     正是 `曝光 +30` / `色温 +41` 在渲染那一刻叠上去的结果。

   **导出图 = 生成的 base + 滑块在渲染时叠加**，这就是「参数永远不烘焙进 base」的视觉铁证。

### 6.3 一次「模型主动不花钱」的观察（正面）

第一次尝试用「把后面那个人去掉」时，路由返回：

```
route=generate  editPrompt="Remove the blurry figure or object in the background..."
reply=照片里我只看到这位女士，没发现后面还有人——您是不是指背景某个模糊的地方？
```

`needsDisambiguation=true`（回复文本表明如此，且 `/api/edit` **确实没有发出**）。
前端 `applyDecision` 的「拿不准就别动手」生效了——**模型自己拦下了这一笔 12,900 tokens**。
这是设计意图的正确落地，值得记一笔。

---

## 7. 断网测试（完成标准之一）

```
断网前滑块：{'曝光': 46, '对比度': 0, '高光': 0, '阴影': 0, '饱和度': 25, '色温': -35, '清晰度': 0, '暗角': 0}
已断网（context.set_offline(True)）
前端已完成失败处理（忙碌提示消失）
断网后滑块：{'曝光': 46, '对比度': 0, '高光': 0, '阴影': 0, '饱和度': 25, '色温': -35, '清晰度': 0, '暗角': 0}
对话区内容：
    '准备好啦，说说想怎么改？\n回到这一步'
    '把背景换成海边'
    '连不上服务器，检查一下网络？'
>>> 断网后滑块一个没变：✅ 是
>>> 断网恢复后仍能保存：✅ test-photos/e2e_offline_recovered.jpg (124114 字节)
```

断网时用户看到的是**人话**（「连不上服务器，检查一下网络？」），不是裸错误，参数一个没丢。

---

## 8. 卡片文案抽样（看它们像不像人话）

四次运行里真实拿到的卡片（label / route / 字数）：

| # | label | route | 字数 |
|---|---|---|---|
| 1 | 脸太黑了想亮起来 | params | 8 |
| 2 | 肤色灰灰的想暖一点 | params | 9 |
| 3 | 画面太闷想通透些 | params | 8 |
| 4 | 让画面通透一点 | params | 7 |
| 5 | 我要更亮一些 | params | 6 |
| 6 | **让大背景更真实** | **generate** | 8 |
| 7 | 光线太暗了，亮一点 | params | 9 |
| 8 | 调个暖色调，太冷了 | params | 9 |
| 9 | 皮肤通透一点，别发灰 | params | 10 |
| 10 | 照片太暗想调亮 | params | 7 |
| 11 | 颜色太冷想暖一点 | params | 8 |
| 12 | **头发太乱想整理下** | **generate** | 8 |

**评价：像人话。** 全部 ≤ 12 字（最长 10 字），第一人称口语，**没有出现任何专业术语**
（没有「色阶」「曲线」「HSL」「饱和度」「白平衡」），三条之间不重复，且**确实读懂了这张照片**
（12 张里 11 张围绕"暗 / 灰 / 冷"，正是这张照片真实的毛病）。

有一处**文案与动作对不上**值得记：`让大背景更真实` / `头发太乱想整理下` 这两张是 `generate` 卡片，
点下去会走 12,900 tokens 的生成。文案本身是口语的，但**没有任何地方告诉用户"这一张要等、要花钱"**。

---

## 9. 不符合预期的地方（如实汇总，不修饰）

1. **上游不稳定是常态，不是偶发。** 4 次冒烟里 `/api/suggest` 降级 1 次、路由降级 2 次
   （其中 1 次退化成静默空转）。**这不是本计划的实现问题，是上游 + 免费/flash 档模型的固有问题**，
   但它直接决定了用户看到的东西。计划里「已知取舍 #1/#2」已经预判了延迟与降级的代价，
   实测说明**这两条不是理论风险，是常态化发生的**。
2. **`route=params` + `degraded=true` + 无 deltas 是静默空转**：用户请求被丢掉，但界面没有任何异常提示。
3. **`reconcile()` 缺一条 `generate + hasParams + hasEdit → both`**：会导致用户明确说出的调色半句被静默丢弃，
   而 `degraded` 还是 `false`（连信号都没有）。**未修，留给控制方决策。**
4. **「上传→卡片」11~13 秒，紧贴 `SUGGEST_WAIT_MS = 10s`**：卡片经常在用户已被告知可以自己说话之后才出现。
5. **`--with-edit` 没打真上游**（见 §6，配额取舍）。
6. **服务没起时脚本是裸堆栈**（探针 E），退出码正确但输出难看。没改，因为 brief 没要求。
7. 第 2 次冒烟那次（只留了片段）**退出码为 1 但完整输出没有留档**——这是本次验收记录的一个缺口。

---

## 10. 完成标准对照

| 完成标准 | 状态 |
|---|---|
| `npm test` 全绿 | ✅ **199 passed / 18 files** |
| `npm run typecheck` 两边都过 | ✅ `exit=0` |
| `.env` 从未被提交过 | ✅ `git log --all --full-history -- .env` 输出为空 |
| 真实照片走通：上传 → 卡片 → 打字 → 画面变 → 保存 | ✅ 浏览器实测（§6） |
| 30 秒验收线实测达标 | ✅ 17.1 / 20.4 / 21.7 秒 |
| 生成式编辑后滑块依然生效 | ✅ 八个滑块一个没变（§6.2） |
| 生成中断网滑块一个没变 | ✅（§7） |
| 验证记录写在本文件 | ✅ |
| `test-photos/` 没被入库 | ✅ `git ls-files` 无匹配（已在 `.gitignore`） |

---

## 11. 复现用的探针（临时，均不入库）

放在 `.superpowers/`（已被 `.gitignore` 排除）：

- `smoke-stub.mjs` —— 打桩服务，用来证明冒烟断言真的会红（§1.2），零成本
- `e2e_probe.py` —— 浏览器 30 秒线 + 生成式编辑 + 滑块幸存（Playwright / Python）
- `offline_probe.py` —— 断网时滑块不丢（§7）

跑法（Windows / git bash，需要 `PYTHONIOENCODING=utf-8`，否则 GBK 控制台会崩）：

```bash
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
node .superpowers/smoke-stub.mjs &          # 打桩，配 SMOKE_BASE=http://localhost:8899
python .superpowers/e2e_probe.py "把背景换成海边"
python .superpowers/offline_probe.py
```
