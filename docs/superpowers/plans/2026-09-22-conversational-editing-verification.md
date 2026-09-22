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

`--with-edit` 只是**三个前提之一**：命令行给了它、第 4 项给了非空 `edit_prompt`、
且模型**没说拿不准**（`needsDisambiguation === false`）。最后一条是裁定 ⑨ 补的——
模型说拿不准时脚本**只报告、不调用**，那笔钱不花（§2.6）。

前端在另一个终端：`npm run dev`（Vite 5173，`/api` 代理到 8787）。

---

## 0. 先说结论

| 项 | 结果 |
|---|---|
| 冒烟 1~5 项能跑通 | ✅（脚本语义见 §1.2：**断言我们能控制的，报告模型的选择**） |
| **第 3 项「天太灰了」从没走生成** | ✅ **留档的 6 次里，5 次是 `params` 且 `degraded=false`**；第 6 次 `degraded=true`（模型没守 `route` 枚举），按裁定 ⑥ 判为**无法判定**——**一次都没走生成** |
| 30 秒验收线 | ✅ **17.1 / 20.4 / 21.7 秒**（三次实测，均 ≤ 30） |
| 生成式编辑端到端 | ✅ 真跑通一次，出图正确、脸保住了（浏览器，真照片） |
| 生成后滑块依然生效 | ✅ 八个滑块一个没变 |
| 断网时滑块一个没变 | ✅ |
| **`--with-edit` 打真上游** | ✅ **跑了，成功**（§2.5）：`/api/edit` 200、回图 939 KB、尺寸 1024×768 与声明一致 |
| **上游稳定性** | ⚠️ **明显不稳**：7 次冒烟里 **5 次**至少出现一次 `degraded=true`，累计 **8 次**模型调用降级（`/api/suggest` 2、`/api/route` 6）—— 见 §5 |
| 裁定 ⑤ → ⑦（`reconcile` 补洞 → 改通用规则） | ✅ 已实施，两变异对照见 §5.1 / §5.2 |
| 裁定 ⑧（脚本尺寸不符 → 换对齐底图） | ✅ 已修，且新增一条硬断言钉住它（§2.5、§1.2） |
| 裁定 ⑨（拿不准时不许花钱） | ✅ 已修（§2.6）：`needsDisambiguation === false` 进付费前提；打桩两跑证明删掉它必红（`EXIT=1`，stub 记到 1 次 `/api/edit`） |

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

### 1.2 断言语义：**断言我们能控制的，报告模型的选择**（评审裁定 ⑥）

brief 的脚本全程只有 `console.log`，**任何一步坏掉都仍然 `exit 0`**。本项目已经发现过八处「断言对它命名的事变不了红」的缺陷，所以第一版把每一步都写成了硬断言。

**但真实上游的实测推翻了那个做法**：7 次打真实上游的冒烟里，**5 次至少出现一次 `degraded=true`，累计 8 次模型调用降级**（`/api/suggest` 2 次、`/api/route` 6 次，含 1 次静默空转与 1 次没守 `route` 枚举）。**这看起来是常态，不是偶发。** 对模型的选择下硬断言，等于让脚本在上游一抽风时变红；**那是噪声不是信号——一个常态变红的脚本，人就会开始忽略它，它也就死了。**

所以脚本改成三档（判据写进了 `scripts/smoke.mjs` 的头部注释）：

| 档 | 语义 | 是否决定退出码 |
|---|---|---|
| `check()` | **硬断言**，只用于**我们能控制的东西**（HTTP 状态码、我们自己的协议） | ✅ 失败 → `exit 1` |
| `warn()` | 软警告（如卡片文案超 12 字） | ❌ |
| `report()` | 如实报告**模型的选择**，给出判读 | ❌ |

**唯一的例外是第 3 项**（「天太灰了」必须走 `params`）：它是「调色零成本」这个成本模型的地基，对**模型的选择**也保留硬断言——但它必须区分**两种红**，因为这两种情况的处理完全不同：

- `degraded=true` → 模型根本没答上来（上游抽风）。**不能据此说我们的代码有问题** → 判为「本次无法判定」，只报告，不改退出码；
- `degraded=false` 但 `route≠params` → 模型是**老实答的**却答错了，那就是我们的提示词/校验层有问题 → **硬红**。

**这些断言真的会红吗？——用打桩服务（`.superpowers/smoke-stub.mjs`，返回故意错误的数据，**零成本、不碰真实 API**）逐个验证：**

| 探针 | 故意做坏什么 | 结果 |
|---|---|---|
| `none` | 全对 | `EXIT=0` |
| `route3` | 第 3 项返回 `generate`，且 `degraded=false`（**老实答错**） | **`EXIT=1`**，`❌ 走参数路 = 零成本 — 本该走参数路，实际走 generate；degraded=false 说明模型是**老实答的**——那这就是我们的提示词/校验层有问题，不是上游的事` |
| `route3_degraded` | 第 3 项退化成 `params` + 无 deltas + `degraded=true` | `EXIT=0`，`⚠️ 走参数路 = 零成本 —— 本次**无法判定**（上游抽风，不是"路由把调色送进了生成"）` |
| `route45` | 第 4/5 项返回与期望不符的值 | `EXIT=0`，汇总为 **3 条"模型的选择"观察**，明说**不改退出码** |
| `health_get` | 健康检查**任何方法**都返回 404（我们的协议真坏了） | **`EXIT=1`**，`❌ 健康检查 200 且 ok=true — 实际 status=404` |
| `health` | 只有 **POST** 返回 404，GET 正常 | **`EXIT=0`** —— 这就是 §1.1 那条 GET 偏离的**独立证据**：脚本若照 brief 用 POST，这一格必然 `EXIT=1` |
| **`--with-edit` 整条路**（打桩） | 打桩的 `/api/edit` 照常回 200 | `EXIT=0`，第 6 项四步全绿：尺寸守卫 → 200 → 有图 → 尺寸一致 → 落盘 |
| **尺寸守卫（裁定 ⑧）** | 把声明改回 `1216×800`（**就是这次修掉的那个 bug 的原样**） | **`EXIT=1`**，`❌ 声明的 size 与底图实物一致 — 实物 1024×768，声明 1216×800`，并**跳过那笔花钱的调用** |
| **裁定 ⑨：拿不准时不许花钱**（`BREAK=unsure`：第 4 项给**非空 prompt**，但 `needsDisambiguation=true`） | stub 额外记录"`/api/edit` 被调用了几次" | `EXIT=0`，第 6 项打印「⏭ 跳过 —— **没有花这笔钱**」，理由写明是**模型拿不准**；**stub 命中数 = 0** |
| **同上，把那行前提删掉** | `if (WANT_EDIT && hasPrompt && !unsure)` → `if (WANT_EDIT && hasPrompt)` | **`EXIT=1`**，`❌ 模型说拿不准时，一次付费调用都不许发 — 第 4 项 needsDisambiguation=true（拿不准），却仍然发起了 1 次 /api/edit`；**stub 命中数 = 1** |
| 死服务 | 服务根本没起 | `EXIT=1`（裸 ECONNREFUSED 堆栈，够响但不好看） |

**第 3 项那条是真判断，不是打印一行就算** —— 探针 `route3` 就是专门把它做坏后跑的；而 `route45` 反证了"模型侧的东西不再让脚本变红"。


---

## 2. 冒烟实测输出（原样贴）

> **2.1~2.3 是裁定 ⑥ 之前那一版脚本的真实输出，原样保留不改写**——它们记录的是当时的观测事实。
> 但要注意：那些 `❌ 走 both` / `❌ 走生成路` 里，**只有一部分是"我们的代码有问题"，其余是模型侧的选择**。
> 按照 2.4 的新语义，前者会红，后者只会变成 `⚠️` 观察。历史输出里的 `❌` 字样因此**不能**直接对照现在的判据。
> §5 里的 `reconcile` 缺口（真的属于我们的代码）已在裁定 ⑤ 修复。

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

### 2.4 裁定 ⑥ 之后的一次运行（**新语义下的真实输出，原样贴**）

```
底图 D:\RuiXing\spike\evidence\real_1027.jpg

1. /api/health          200  0.3s  {"ok":true}
     ✅ 健康检查 200 且 ok=true
2. /api/suggest         200  15.4s  degraded=true
     ✅ 建议卡片端点 200
     ⚠️ 拿到了至少 1 张卡片 — 实际 0 张 （本次 degraded=true：模型没答上来，**上游抽风**，不是我们的代码不对）
     ⚠️ 卡片没有降级（degraded=false） — degraded=true 说明模型没按约定形状答，卡片是空壳

3. "天太灰了"           200  6.5s
     route=params  degraded=false  deltas={"exposure":25,"contrast":30,"highlights":10,"shadows":20,"saturation":20,"temperature":25,"clarity":15,"vignette":0}
     reply=画面确实有点闷，我把它提亮加暖了，通透多了～
     ✅ 纯调色路由 200
     ✅ 走参数路 = 零成本
     ✅ 给的确实是调色增量（非空 deltas）

4. "把后面那个人去掉"   200  27.6s
     route=generate  degraded=true  edit_prompt=""
     ✅ 纯生成路由 200
     ✅ 走生成路（期望 generate）
     ⚠️ 给了非空 edit_prompt（第 6 项的前提） — 本次是降级结果，prompt 是用户原话（…上游抽风…）

5. 三合一（且已调过色温-30）  200  17.2s
     route=generate（期望 both）  degraded=true  deltas={}
     reply=我直接按你说的试了一下。
     edit_prompt="天太灰了，人再亮点，把后面那个人去掉"
     ✅ 三合一路由 200
     ⚠️ 走 both（参数 + 生成都要） — 实际走 generate （…上游抽风…）
     ⚠️ both 的两半都给了（deltas 与 edit_prompt 皆非空） — deltas={} editPrompt="天太灰了，人再亮点，把后面那个人去掉"

6. /api/edit            跳过（加 --with-edit 才跑，它会花钱）

────────────────────────────────────────────────────────────────
判据（裁定 ⑥）：**断言的是我们能控制的东西，报告的是模型的选择。**

⚠️  5 条"模型的选择"不如预期（**不改退出码**，多为上游抽风）：
     …（同上的 5 条）

✅ 所有"我们能控制的东西"全部通过（另有 5 条模型侧的观察，见上，不计入退出码）
EXIT=0
```

**这一次的读法（这正是裁定 ⑥ 想要的效果）：**

- 退出码 **0**，结论一句话读得懂：**我们自己的协议（三个端点都 200、健康检查 ok）全绿**；模型侧有 5 条不如预期，成因都标着 `degraded=true`，即**上游抽风**。
- 第 3 项 —— 全脚本唯一的硬断言、也是成本模型的地基 —— **`route=params`、`degraded=false`、八个 deltas 全给了**，干净通过。
- 第 5 项这一轮是**彻底降级**（`fallbackDecision` 把整句原话当 prompt 送生成，`deltas={}`）。在旧语义下这会是一条刺眼的 `❌`；新语义下它是 `⚠️`，并且**明说"这是上游抽风，不是我们的代码不对"**，还提醒重跑一次再判。
- 这一次 4 次模型调用里降级了 **3 次**。**如果按旧语义，这一轮会以 `EXIT=1` 结束，而实际上我们的代码一行都没错。**

### 2.5 `--with-edit` 打真上游（**花了钱的那一次，原样贴**）

裁定 ⑧ 修完尺寸问题后跑的一次。**这一节是 §6 那个"没跑"的答案：跑了，成功了。**

```
底图 D:\RuiXing\spike\evidence\real_1027.jpg  （路由/建议用）
     生成项用 D:\RuiXing\spike\evidence\input_scene.jpg —— 1024×768，宽高都是 32 的倍数（size 必须与实物一致）

1. /api/health          200  0.2s  {"ok":true}
     ✅ 健康检查 200 且 ok=true
2. /api/suggest         200  7.6s  degraded=false
     ✅ 建议卡片端点 200 / ✅ 至少 1 张卡片 / ✅ degraded=false
     [params] 我想亮一点  (5 字)  deltas={"exposure":25}
     [params] 让皮肤更通透  (6 字)  deltas={"exposure":8,"contrast":12}
     [params] 想要暖一点  (5 字)  deltas={"temperature":28}

3. "天太灰了"           200  6.2s
     route=both  degraded=true  deltas={"exposure":35,"contrast":22,"highlights":-5,"shadows":20,...,"clarity":12}
     reply=这张其实没拍到天，但你说得对，整体是有点闷灰，我帮你把光线提亮、让红唇更跳一点。
     ✅ 纯调色路由 200
     ⚠️ 走参数路 = 零成本 —— 本次**无法判定** — 模型这次没答上来，这是**上游抽风**……
     （脚本没有把它当成"路由把调色送进了生成"—— 这正是裁定 ⑥ 要的分辨力）

4. "把后面那个人去掉"   200  11.2s
     route=generate  degraded=false
     edit_prompt="No edit - user requested removal of a person in the background,
                  but no other person is visible in this solo portrait. Co…"
     ✅ 纯生成路由 200 / ✅ 走生成路 / ✅ 给了非空 edit_prompt

5. 三合一（且已调过色温-30）  200  4.7s
     route=both（期望 both）  degraded=false  deltas 八个全给
     reply=好，我先把脸点亮一点、调出通透感；不过你这张里没有看得清的「后面那个人」，是指谁呀？
     edit_prompt="Brighten and clean up the woman's face … while removing the second person behind her…"
     ✅ 三合一路由 200 / ✅ 走 both / ✅ 两半都给了

6. /api/edit
     底图 …\input_scene.jpg   实物 1024×768   声明 1024×768
     ✅ 声明的 size 与底图实物一致（不一致模型会重构构图）
     响应 200  7.6s  输出 939 KB
     ✅ 生成式编辑 200
     ✅ 回来了图片数据
     ✅ 回图尺寸与请求一致（1024×768）
     已存到 test-photos/smoke_edit.png

⚠️  1 条"模型的选择"不如预期（**不改退出码**）：
     - 走参数路 = 零成本 —— 本次**无法判定** — …

✅ 所有"我们能控制的东西"全部通过（另有 1 条模型侧的观察，见上，不计入退出码）
EXIT=0
```

**这一次要如实说清楚的三件事：**

1. **尺寸那一步真的修好了，而且是被断言钉住的**：`实物 1024×768`、`声明 1024×768`，
   同一条断言在**改回旧的 `1216×800` 时立刻变红**（§1.2 的探针表有那一格）。
   这不是"看了一眼觉得对"，是"改坏它会红"。

2. **第 3 项这一轮是"无法判定"，不是失败。** 模型这次没守 `route` 枚举
   （`degraded=true`，`inferRoute` 按内容推成了 `both`）。脚本照裁定 ⑥ 把它算成**上游抽风**，
   并明说"重跑一次再判"。**没有把它误报成"路由把调色送进了生成"**——那会是一次冤枉。
   （`reply` 倒是人话，还很贴照片：「这张其实没拍到天……」）

3. ⚠️ **第 6 项虽然 200 了，但这一笔钱买到的画面信息近乎为零。**
   第 4 项的 `edit_prompt` 根本**不是**一句编辑指令，而是模型的**拒绝语**
   （"No edit - …no other person is visible in this solo portrait"）——它想说"这张照片里没有别人可去掉"。
   脚本只检查 `editPrompt` 非空，就把它当指令送进了 `/api/edit`。
   于是**往返验证全部通过（200 / 有图 / 尺寸对），但画面没变**：

   | 指标 | 值 |
   |---|---|
   | 尺寸 | 1024×768（与底图同） |
   | 平均绝对差 | **3.157 / 255** |
   | 最大差 | 35 / 255 |
   | 差 > 32 的像素 | **0.000 %** |

   （方法是 `.superpowers/img_diff.py`：把两张图都画进 canvas 逐像素比。底图是 JPEG、回图是 PNG，
   不可能逐字节相等，所以看的是"差值落在压缩噪声那一档，还是内容真变了那一档"。
   **如果没有真被改动，就不可能出现成片差 > 100 的像素，而这里是 0%。**）

   **这是本次验收新发现的一处缺陷**：第 6 项只看 `editPrompt` 非空，不看 `needsDisambiguation`。
   前端 `App.tsx` 是会拦的（§6.3 记过一次正面案例，裁定 ④ 也把它写进了完成标准），
   **脚本这一侧当时没有**，于是它会拿一句拒绝语去花掉 12,900 tokens。
   → 已按评审裁定 ⑨ 修掉，修法与证明见 **§2.6**。

---

### 2.6 裁定 ⑨：把门补上，并证明它真的会拦（**打桩，零成本**）

为什么值得单独修：这**不是"工具不完美"**。是它证明那笔钱是白花的，而**这发生在脚本的第一次
真实运行上**——说明不是偶发。这个脚本是项目唯一的上游回归工具，将来会被反复跑，
每跑一次都可能在模型拒绝时白烧一次生成。

修法（裁定 ⑨ 原文）：把 `needsDisambiguation === false` 加进付费调用的前提；不满足时
**只报告、不调用**，并把"跳过"的理由打清楚（是"模型拿不准"而不是"没给出 prompt"）。

**不重跑 `--with-edit`**（钱已经花够，而这轮改动阻止的正是花钱）。改用打桩证明：
`.superpowers/smoke-stub.mjs` 新增 `BREAK=unsure`——`/api/route` 对第 4 项回**非空的 prompt**
（内容就是 §2.5 那次真跑的原话）但 `needsDisambiguation: true`。同时 stub **每被 `/api/edit`
打中一次就记一行**日志：**"到底有没有花这笔钱"必须能从脚本进程之外看见**，
不能只看脚本自己打印的话（那正是被验对象自己作证）。

**① 门在（原样的脚本）**

```bash
BREAK=unsure node .superpowers/smoke-stub.mjs &
SMOKE_BASE=http://localhost:8899 node scripts/smoke.mjs --with-edit
```

```
4. "把后面那个人去掉"   200  0.0s
     route=generate  degraded=false  edit_prompt="No edit - no other person is visible in this solo portrait."
     ✅ 纯生成路由 200
     ✅ 走生成路（期望 generate）
     ✅ 给了非空 edit_prompt（第 6 项的前提）      ← ② 满足，光看这一条就会去花钱

6. /api/edit            ⏭  跳过 —— **没有花这笔钱**
     理由：模型自己说它拿不准（needsDisambiguation=true），不是它没给出 prompt。
     它同时给了 prompt："No edit - no other person is visible in this solo portrait."
     上一个真跑就是这么烧掉 12,900 tokens 的：prompt 非空，但内容是句拒绝语，
     生成出来的图与底图逐像素比对"差 >32"的占比是 0.000%。
     ⚠️ --with-edit 这次没能真的跑起来 — 模型说拿不准（needsDisambiguation=true），脚本按裁定 ⑨ 主动跳过，不是我们的代码坏了。
     ✅ 模型说拿不准时，一次付费调用都不许发

⚠️  1 条"模型的选择"不如预期（**不改退出码**）：
     - --with-edit 这次没能真的跑起来 — …

✅ 所有"我们能控制的东西"全部通过（另有 1 条模型侧的观察，见上，不计入退出码）
EXIT=0
```

**外部证据**：`grep -c '^HIT' .superpowers/edit_hits.log` = **0**。钱一次都没花。

**② 变异：把那行前提删掉**

只改一处（`diff` 确认只此一行）：`if (WANT_EDIT && hasPrompt && !unsure) {`
→ `if (WANT_EDIT && hasPrompt) {`

```
6. /api/edit
     底图 …\input_scene.jpg   实物 1024×768   声明 1024×768
     ✅ 声明的 size 与底图实物一致（不一致模型会重构构图）
     响应 200  0.0s  输出 0 KB
     ✅ 生成式编辑 200
     ✅ 回来了图片数据
     ✅ 回图尺寸与请求一致（1024×768）
     已存到 test-photos/smoke_edit.png
     ❌ 模型说拿不准时，一次付费调用都不许发 — 第 4 项 needsDisambiguation=true（拿不准），却仍然发起了 1 次 /api/edit
     ✅ 付费调用没有重复（一次跑最多一次）

❌ 1 条**我们的代码**有问题：
     - 模型说拿不准时，一次付费调用都不许发 — …
EXIT=1
```

**外部证据**：`grep -c '^HIT'` = **1**。

| | 门在 | 删掉前提 |
|---|---|---|
| 退出码 | `0` | **`1`** |
| stub 收到的 `/api/edit` 命中数 | **`0`** | **`1`** |
| 红的那条断言 | — | `模型说拿不准时，一次付费调用都不许发` |

**这条断言为什么写在所有分支之外**：如果它写在"跳过"分支里，删掉前提时它会**跟着分支一起消失**——
连红都红不了，正是本次验收反复遇到的那种"断言对它命名的事变不了红"的写法。放在分支之外，
前提一被删，脚本就会真的去调用，这条必红。变异跑的第 6 项里，付费路径自己那三条断言全是绿的，
**唯一抓到它的就是这条**。

（收尾：stub 已杀，8899/8787/5173 均已释放；变异跑写出的 `test-photos/smoke_edit.png` 已用
`--with-edit` 真跑那份覆盖回去，`test-photos/` 全程未入库。）

---

## 3. 第 3 项 `route` 的实际值 —— **本次验收的核心**

> 这一条是「调色零成本」这个产品形态的地基。如果「天太灰了」走了生成，
> 一句纯调色会被送进 12,900 tokens 的生成，整个成本模型就垮了。

**七次实测（打真实上游的冒烟共 7 次；前 4 次是裁定 ⑥ 之前的记录，后 3 次是之后的）：**

| 次 | `route` | `degraded` | deltas |
|---|---|---|---|
| 1 | **`params`** ✅ | false | exposure 20 / contrast 15 / saturation 15 / temperature 25 / clarity 10 … |
| 2 | （该次输出未完整留档） | — | — |
| 3 | **`params`** ✅ | false | exposure 40 / contrast 40 / highlights 25 / shadows 20 / saturation 15 / temperature 10 / clarity 30 |
| 4 | **`params`** ✅ | false | exposure 20 / contrast 15 / highlights 0 / shadows 10 / saturation 15 / temperature 25 / clarity 10 |
| 5 | **`params`** ✅ | false | （该次只留档了 `route`/`degraded`） |
| 6 | **`params`** ✅ | false | exposure 25 / contrast 30 / highlights 10 / shadows 20 / saturation 20 / temperature 25 / clarity 15 |
| 7 | `both`（**模型没守枚举**，`inferRoute` 推的） | **true** | exposure 35 / contrast 22 / highlights -5 / shadows 20 / saturation 15 / temperature 15 / clarity 12 |

**结论：5/5 干净观测全是 `params` 且 `degraded=false`，另 1 次按裁定 ⑥ 判为"无法判定"。
一次都没有真的走生成。** 第 7 次不是反例：`degraded=true` 说的是"模型这次没按约定形状答"，
不是"我们的路由把纯调色送进了生成"——**这两件事必须分开**，正是裁定 ⑥ 的核心。

> 为什么这条能在上游这么不稳的情况下还这么稳：`ROUTER_SYSTEM` 把「调色一律走 params」写死了，
> 而且这句话不依赖模型"听懂"得多好——它只需要认出"这是调色"。第 6 次那轮里 `/api/suggest`
> 和第 4、5 项全降级了，第 3 项依然干净，**这本身就是这条断言值得保留硬断言的证据**。

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

7 次打真实上游的冒烟（同一份代码、同一张图、同一句话），结果**不一样** —— **5 次至少出现一次 `degraded=true`，累计 8 次模型调用降级**：

| 项 | §2.1 那次 | §2.2 那次 | §2.3 那次 | §2.4 那次（裁定 ⑥ 之后） |
|---|---|---|---|---|
| `/api/suggest` | 20.1s，3 张卡片，degraded=false | — | **5.0s，0 张卡片，degraded=true** | **15.4s，0 张卡片，degraded=true** |
| 「把后面那个人去掉」 | `generate`，英文 prompt 正常 | `generate`，**降级**（prompt=中文原文） | **`params`，degraded=true，editPrompt 为空** | **`generate`，degraded=true，editPrompt 为空** |
| 三合一 | **`generate`**（应为 both） | `both` ✅ | `both` ✅ | **降级**：`generate`，deltas 空，prompt=整句原话 |
| 「天太灰了」 | `params` ✅ | — | `params` ✅ | `params` ✅ |

**一句话：留下完整输出的那几轮里，「三合一」只在 §2.2 / §2.3 / 裁定 ⑥ 前那轮走对了 `both`，其余都不对或干脆降级；唯一稳的是第 3 项那条调色。**

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

**另外还有一个真实的逻辑缺口 —— 已由评审裁定 ⑤ 修复（见 §5.1）：**

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

`reconcile()` 自己的注释写的是「声明与内容冲突时以**内容**为准」——按这条原则，
这里本来就该有一条 `generate + hasParams + hasEdit → both`，**原来是漏了**。

### 5.1 裁定 ⑤：补上 `reconcile()` 的第四条分支

四个组合里，前三条都在（`params→generate`、`generate→params`、`both→params`），
**只有第四条 `generate + hasParams + hasEdit` 缺**。它是「`both` 缺 `edit_prompt` → `params`」的**对称项**：

| 声明 \ 内容 | 只有 deltas | 只有 edit_prompt | 两半都有 |
|---|---|---|---|
| `params` | 原样 | → `generate` | **→ `both`**（§5.2 的通用规则；⑤ 当时写的是 `→ generate`，已按出货代码校正） |
| `generate` | → `params` | 原样 | **→ `both`（原缺，裁定 ⑤ 补上）** |
| `both` | → `params` | **原样（保持 `both`）**（没有 deltas 可降——剩下的那一半正是生成。⑤ 当时写的是 `→ params`，已按出货代码校正） | 原样 |

> **2026-09-22 复核（全分支审查）**：**§5.2 取代了 §5.1 的第 3 格**——`reconcile` 里那条特例已被换成通用规则
> `if (hasParams && hasEdit) return 'both'`（不管模型声明的是哪个），所以「两半都有」那一列**三行都归 `both`**，
> 上表两个单元格（第 1 行第 3 列、第 3 行第 2 列）已按**出货代码** `server/validate.ts` 的 `reconcile()` 校正。
> 校正依据：通用规则那条有测试钉着（`validate.test.ts`「route 说 params 但两半内容都有时…以内容为准走 both」）；
> 「`both` + 只有 edit_prompt → 保持 `both`」**只验证到读代码这一层**——四条分支都不命中，落到末尾的 `return route`，
> **仓库里没有一条测试会在它改成 `params` 时变红**，如实记在这里。

修复见 `server/validate.ts` 的 `reconcile()` 与 `server/validate.test.ts` 里
「route 说 generate 但既吐了 deltas 又给了 edit_prompt 时，以内容为准走 both」。

**变异验收（证明这条测试真的会红，不是走过场）**：把新分支注释掉
（`// if (route === 'generate' && hasParams && hasEdit) return 'both'`），只跑 `server/validate.test.ts`：

```
× parseDecision > route 说 generate 但既吐了 deltas 又给了 edit_prompt 时，以内容为准走 both
  AssertionError: expected 'generate' to be 'both'
Tests  1 failed | 28 passed (29)
```

恢复该分支后 **29 passed**，`npm test` 全量 **200 passed / 18 files**（原 199，**+1**）。
这就是那条元判据要的答案：**把被验的那行改坏，这条断言会红。**

> 顺带说明裁定 ⑥ 的边界在哪：**服务端归一化之后的 `route` 是我们自己的协议**——
> `reconcile` 的结果由确定性代码算出来，不随上游抽风漂移，所以它该断言。
> 而"模型这次打算走哪条路"是**模型的选择**，只能报告。
> 第 3 项之所以能保留硬断言，是因为它问的正是"归一化之后走了哪条路"，
> 而且 `degraded=true` 时脚本会另走"无法判定"分支、不把上游抽风算成我们的错。

### 5.2 裁定 ⑦：`reconcile` 别再补格子了，改成通用规则

裁定 ⑤ 补完第 3 格之后，复审又探出一个**新的格子**：

```
{route:'params', param_deltas:{exposure:30}, edit_prompt:'Remove the bin.'}
→ route 停在 params、degraded=false
```

前端只在 `route` 是 `generate`/`both` 时才调 `runGenerate`，于是**"去掉那个垃圾桶"被静默丢掉，
连信号都没有**。这是同一个洞的**第四次**：

| 次序 | 格子 | 谁发现 |
|---|---|---|
| 1 | `params` + 无 deltas + 有 edit | Task 4（`hasParams` 的死分支） |
| 2 | `both` + 有 deltas + 无 edit | Task 4 复审 |
| 3 | `generate` + 有 deltas + 有 edit | Task 10（裁定 ⑤） |
| 4 | **`params` + 有 deltas + 有 edit** | **Task 10 复审** ← 第 3 格的镜像 |

**修到第四次，说明修法本身有问题**——把一条通用规则拆成一串特例分支，就注定要一格一格地漏。
裁定 ⑦ 把裁定 ⑤ 那条特例**换成通用规则**：

```ts
// 通用规则：**内容两半都有，那就是 both**，不管模型声明的是哪个。
if (hasParams && hasEdit) return 'both'
```

它一次盖住两格（`params` 声明和 `generate` 声明），以后也不用再补。

**两变异对照（`.superpowers` 里跑，零成本）**：

| 注射的变异 | 结果 | 说明 |
|---|---|---|
| 通用规则 → 换回特例 `route==='generate' && hasParams && hasEdit` | **1 红**：`route 说 params 但两半内容都有时…`；`route 说 generate …` **保持绿** | 正好证明**两条测试各钉住一格** |
| 通用规则 → 整条删掉 | **2 红**：两条都红 | 证明这两条都不是摆设 |

（恢复后 `server/validate.test.ts` **30 passed**。）

> 一个如实说明：第一次跑变异时我打偏了——`inferRoute()` 里有一行**一模一样**的
> `if (hasParams && hasEdit) return 'both'`，`String.replace` 命中的是它，于是红的是
> `inferRoute` 的测试而不是 `reconcile` 的。加了唯一锚点（带上后面的 `return route`）重跑才对。
> **变异探针本身也会打偏**，所以每次都得核对"红的是不是我打算弄红的那条"。

---

## 6. 生成式编辑：端到端真跑通了一次

**`scripts/smoke.mjs --with-edit` 一开始没对真实上游跑**（配额纪律：Task 9 已经花掉 4 次真实调用），
当时把**唯一的一次真实生成**用在了**浏览器端到端**上——同一件事（真打 `/api/edit`），
但能一次覆盖三条完成标准（真照片走通 / 生成后滑块幸存 / 生成后再保存），信息量严格更大。

**后来（评审裁定 ⑧）补跑了**：修掉脚本"声明尺寸与实物不符"的缺陷之后，
`node scripts/smoke.mjs --with-edit` **对真上游跑了一次并成功**——原始输出在 **§2.5**。
两次都打到了同一个端点，证据互补：浏览器那次验的是**产品行为**（滑块、导出、构图），
脚本这次验的是**契约**（200 / 有图 / 尺寸一致 / 可重复）。

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

> **更正（评审裁定 ⑧）**：这里原来写着「`scripts/smoke.mjs` 送的是**未经缩放的原图字节** 1200×800，
> 只是把 `width/height` 声明成 1216×800……**这条差异不影响结论**，但记录在案」。
> 前半句是事实，**后半句判断错了**：本计划最关键的实测结论就是"声明的 `size` 与输入图不一致时，
> 模型会重构构图"（地平线从 78% 漂到 65%）。送 1200×800 的字节却声明 1216×800，
> **正是那个会让结果跑歪的条件**——所以脚本在这一项上是坏的。
>
> 修法：**换一张尺寸天然对齐的底图**（`spike/evidence/input_scene.jpg`，1024×768，两个数都是 32 的倍数），
> 声明 `1024×768` 就与实物完全一致，不需要任何缩放处理（脚本是零 canvas 的 Node）。
> 并且**加了一条硬断言**把"实物尺寸 = 声明尺寸"钉住——把声明改回 `1216×800` 它会立刻红（§1.2）。
>
> 浏览器那次（1200×800 底图、声明 1216×800）**结论不受影响**：
> 它验的是"参数没被烤进 base"和滑块幸存，与构图漂移无关。

### 6.2 参数没被烤进 base —— 三重证据

1. **滑块值**：生成前后八个滑块完全一致（`曝光 30`、`色温 41`）—— 生成没有碰过 params。
2. **画布指纹变了**：`-1251190929:33455` → `874011106:41711` —— 生成**确实**换了 base。
3. **肉眼比对**（`test-photos/`，已 gitignore）：
   - `e2e_generated.png`（服务端回来的 base）：背景真的换成了海边（海面 + 远处海岸线，柔焦），
     **人脸完整保住**——五官、红唇、卷发、皮肤质感都在，与 `spike/evidence/real_1027.jpg` 一致。
   - `e2e_after_generate.jpg`（导出文件）：**同一张海边背景，但整体更亮更暖** ——
     正是 `曝光 +30` / `色温 +41` 在渲染那一刻叠上去的结果。

   **导出图 = 生成的 base + 滑块在渲染时叠加**，这就是「参数永远不烘焙进 base」的视觉铁证。

> **2026-09-22 附注（C1 更正后重读证据）**：同一批浏览器验收里还有一条证据——「两次生成的 `imageDataUrl`
> **逐字节相同**」，它记在 `task-9-report.md` 的「铁律 2」一节，当时被当成"第二次不叠加"的**决定性证据**。
> C1（生成送的是最初那张原图而不是当前 `base`）更正之后，这条读法**不成立**：
> 两次发送逐字节相同，**恰好就是"两次都送原图"这个缺陷会产生的现象**，所以它**与 C1 一致**，
> 对"多次生成是不是累积的"**不具判别力**（按更正后的规则，第二次送的应该是**第一次的结果**，两次发送**就该不同**）。
> 本条§6.2 的三重证据不受影响（它验的是"参数没被烤进 base"，与送哪一版底图无关）。
> 验证记录本身没有出现过「生成送的是原图 / 两次发送相同」这类断言（已 grep 全文），出处只在任务报告与过程账里。

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

1. **上游不稳定是常态，不是偶发。** 7 次冒烟里 **5 次**至少出现一次 `degraded=true`，累计 **8 次**模型调用降级
   （`/api/suggest` 2 次、`/api/route` 6 次，其中含静默空转与"没守 route 枚举"）。**这不是本计划的实现问题，是上游 + flash 档模型的固有问题**，
   但它直接决定了用户看到的东西。计划里「已知取舍 #1/#2」已经预判了延迟与降级的代价，
   实测说明**这两条不是理论风险，是常态化发生的**。也正因为它是常态，冒烟脚本的断言语义按裁定 ⑥ 改成了
   **「断言我们能控制的，报告模型的选择」**（§1.2）。
2. **`route=params` + `degraded=true` + 无 deltas 是静默空转**：用户请求被丢掉，但界面没有任何异常提示。
   （**仍未修**——这属于产品行为决策：是给用户一句"我没听懂"，还是什么都不说。）
3. ~~**`reconcile()` 缺一条 `generate + hasParams + hasEdit → both`**~~ → 裁定 ⑤ 先补了这一格，
   **裁定 ⑦ 又发现它的镜像（`params` + 两半都有）也没补**，于是**改写成通用规则**，
   两变异对照确认两条测试各钉住一格（§5.1 / §5.2）。
   **这是同一个洞的第四次修**——教训是修法本身有问题，不是格子没补够。
4. **「上传→卡片」11~13 秒，紧贴 `SUGGEST_WAIT_MS = 10s`**：卡片经常在用户已被告知可以自己说话之后才出现。
5. ~~**`--with-edit` 没打真上游**~~ → **裁定 ⑧ 之后补跑了，成功**（§2.5）。原来的取舍（把唯一一次真实生成
   给浏览器端到端）在当时是合理的，但**脚本本身当时是坏的**（声明尺寸与实物不符），这一点没被发现。
6. **服务没起时脚本是裸堆栈**（§1.2 探针表最后一行），退出码正确但输出难看。没改，因为 brief 没要求。
7. 第 2 次冒烟那次（只留了片段）**退出码为 1 但完整输出没有留档**——这是本次验收记录的一个缺口。
8. ~~**【新发现】第 6 项会把一句"拒绝语"当编辑指令送进 `/api/edit`。**~~ → **裁定 ⑨ 已修**（§2.6）。
   原来只检查 `editPrompt` 非空，不看 `needsDisambiguation`。§2.5 那次实测就是：模型给的是
   `"No edit - …no other person is visible in this solo portrait"`，12,900 tokens 花掉了，
   **画面一个像素没变**（差 >32 的像素 **0.000%**）。前端 `App.tsx` 会拦（§6.3），脚本不拦。
   现在把 `needsDisambiguation === false` 加进了付费前提，不满足时只报告不调用；
   并用打桩两跑证明"删掉这行前提必红"（`EXIT=1`，且 stub 记到 1 次 `/api/edit`）。

---

## 10. 完成标准对照

| 完成标准 | 状态 |
|---|---|
| `npm test` 全绿 | ✅ **201 passed / 18 files**（裁定 ⑤ +1、裁定 ⑦ +1，从 199 起） |
| `npm run typecheck` 两边都过 | ✅ `exit=0` |
| `.env` 从未被提交过 | ✅ `git log --all --full-history -- .env` 输出为空 |
| 真实照片走通：上传 → 卡片 → 打字 → 画面变 → 保存 | ✅ 浏览器实测（§6） |
| 30 秒验收线实测达标 | ✅ 17.1 / 20.4 / 21.7 秒 |
| 生成式编辑后滑块依然生效 | ✅ 八个滑块一个没变（§6.2） |
| 生成中断网滑块一个没变 | ✅（§7） |
| 验证记录写在本文件 | ✅ |
| `test-photos/` 没被入库 | ✅ `git ls-files` 无匹配（已在 `.gitignore`） |
| 冒烟脚本能真的红（不是走过场） | ✅ 打桩探针 **11 格**对照，见 §1.2 |
| `--with-edit` 打真上游跑通一次 | ✅ `EXIT=0`、200、939 KB、1024×768（§2.5） |
| 裁定 ⑤ / ⑦：`reconcile` 通用规则 + 两条测试 | ✅ 两变异对照：换回特例只红 1 条、整条删掉红 2 条（§5.1 / §5.2） |
| 裁定 ⑥：断言语义改为"断言我们能控制的" | ✅ 判据写进脚本头部注释，见 §1.2 |
| 裁定 ⑧：脚本尺寸与实物一致 | ✅ 换天然对齐底图 + **加了一条会红的硬断言**（§1.2 / §2.5） |
| 裁定 ⑨：拿不准时不花钱（`needsDisambiguation` 进付费前提） | ✅ 打桩两跑对照：门在 `EXIT=0` 且 stub 命中 `0`；删掉前提 `EXIT=1` 且命中 `1`（§2.6） |

---

## 11. 复现用的探针（临时，均不入库）

放在 `.superpowers/`（已被 `.gitignore` 排除）：

- `smoke-stub.mjs` —— 打桩服务，用来证明冒烟断言真的会红（§1.2 / §2.6），零成本。
  它还会把每次被 `/api/edit` 打中记进 `.superpowers/edit_hits.log`——
  **"有没有花这笔钱"要从脚本进程之外看得见**（§2.6）
- `e2e_probe.py` —— 浏览器 30 秒线 + 生成式编辑 + 滑块幸存（Playwright / Python）
- `offline_probe.py` —— 断网时滑块不丢（§7）
- `img_diff.py` —— 把两张图都画进 canvas 逐像素比，用来把「看着一样」变成数字（§2.5）
  （为什么不用现成工具：底图是 JPEG、回图是 PNG，不可能逐字节相等，所以要看的
  是**差值落在压缩噪声那一档，还是内容真变了那一档**——判据是"有没有成片差 > 100 的像素"。）
- `sync_plan_smoke.mjs` —— 把计划文档里那份 `smoke.mjs` 整块换成磁盘上的真身，并逐字节复核
- `smoke_mutant.mjs` —— 变异体（只改一行的副本），跑完即弃

跑法（Windows / git bash，需要 `PYTHONIOENCODING=utf-8`，否则 GBK 控制台会崩）：

```bash
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
node .superpowers/smoke-stub.mjs &          # 打桩，配 SMOKE_BASE=http://localhost:8899
python .superpowers/e2e_probe.py "把背景换成海边"
python .superpowers/offline_probe.py
```

**冒烟断言的 6 组对照探针**（零成本，不碰真实 API；结果见 §1.2）：

```bash
# BREAK 取 none / route3 / route3_degraded / route45 / unsure / health / health_get
BREAK=route3 node .superpowers/smoke-stub.mjs &
SMOKE_BASE=http://localhost:8899 node scripts/smoke.mjs; echo "EXIT=$?"
# 跑完记得清掉 8899：留下的 stub 会让下一轮静默连到旧桩上（这个坑踩过一次）
```

> 注意：stub 的 `/api/route` 里**分支顺序要紧**——第 5 项那句话里同时含「再亮点」和「去掉」，
> `route45` 的判断必须排在最前面，否则它会匹配到别的分支，`route45` 那格就假绿了。
> `unsure` 那格刻意**只作用于第 4 项**（纯生成），第 3 项仍回 `params`——
> 否则那轮会因为第 3 项而无关地变红，变异对照就读不出信号了。
