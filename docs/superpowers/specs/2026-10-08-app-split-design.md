# App.tsx 再拆一轮(2026-10-08)

> 用户原话:「我看前端代码有的都2000多行了,这显然是安排不合理的,先检查是否有可重复利用
> 代码块没封装,然后把各种代码块分离出来只在app这个代码文件里面做引用」

## 现状

| 文件 | 行数 | 备注 |
|---|---|---|
| `src/App.tsx` | **3768** | 10-03 拆完是 1745;此后 LUT / 回溯 / 删除 / 转盘 / 工具行 / 裁剪 / 点修 / 账本全写进来了 |
| `src/App.test.tsx` | **9409** | 本轮**不动**(见"不做") |
| 其余全部 | ≤ 740 | |

结构:`import + 常量 + 模块级辅助` 约 300 行,组件体约 2800 行(状态 / 回调 / effect),
JSX 约 630 行。

## 硬规矩(每一批都适用)

1. **原文照搬**:搬走的代码连同注释一字不改;只有"函数边界"本身新写。
2. **依赖数组一条不动**:搬进 hook 的每个 `useCallback`/`useEffect` 依赖数组逐条对照,
   不许"顺手统一"。
3. **不改行为、不改文案、不改 DOM 结构**:测试按文字/结构点按钮,结构不动才不红。
4. **每批两绿**:`npm test` + `npm run typecheck`,以及搬完人工对依赖数组。
5. **一批一提交**,message 照仓库现成风格。
6. 最后一批做完跑一次**真机探针**(dev 服务 + 脚本走一条主流程)。

## 四处真重复(先收口,Batch 1)

1. **裁剪 / 点修的"提交"骨架**(`commitCrop` / `commitRetouch`,注释自己写着
   「和 commitCrop 一字不差的那几条」):await 前读 `baseSeqRef` / `cursorIdRef` →
   回来双重对账作废 → `flushEdit` → 账本一句(pushEdit + settleLedger)→
   `baseSeqRef++` + `markDirty(at,true)` → `setImage` → 清 `pending` / `pendingReplace`。
   → `src/app/baseEdit.ts` 三个纯函数:`beginBaseEdit` / `baseEditStale` / `applyBaseEdit`。
2. **"还原到某一步"三连**(`setImage` + `setParams` + `setLut`):`onJump` /
   `onDeleteMessages` / `ledgerStep` / `loadSession` → 一个 `applySnapshot(s)`。
3. **滤镜那 9 个 props**原样抄给 `ChatPanel` 和 `AdjustmentPanel` 两份 →
   一份 `lutPanelProps` 展开两次。
4. **"清上一张的临时状态"**(`setPending(null)` + `setPendingReplace(null)`):
   `commitCrop` / `commitRetouch` / `onPick` / `resetEditor` / `loadSession` →
   一个 `clearTransient()`(这一对的"漏一处就静默出错"写在原注释里)。

## 六批(稳 → 险)

| # | 内容 | 去哪 | 预计 |
|---|---|---|---|
| 1 | 四处重复收口 | `src/app/baseEdit.ts` + App 内 | −120 |
| 2 | JSX 拆件:顶栏操作条 / 三条横幅 / 裁剪行 / 点修行 | `src/ui/` 四个组件 | −250 |
| 3 | 小簇:通报 / 导航 / 滤镜流程 | `app/useNotice.ts`、`app/useNav.ts`、`app/useLutFlow.ts` | −250 |
| 4 | 落盘簇(flushEdit / flushPersist / dirtyRef / 800ms effect / pagehide) | `app/usePersist.ts`(deps 对象,照 useGeneration) | −350 |
| 5 | 工具簇:裁剪、点修 | `app/useCrop.ts`、`app/useRetouch.ts` | −350 |
| 6 | 恢复会话(380 行 loadSession + 挂载恢复 effect) | `app/useLoadSession.ts` | −400 |

⚠️ 第 6 批风险最高:那一簇里住着三个"错了不报错"的历史 bug(见
`memory/sessions-feature.md`),搬的时候那几个闸门(pickSeqRef / mountedRef /
loadSeqRef / dirtyRef 清空)一个都不许动。

## 不做(本轮)

- 不改任何行为、文案、DOM 结构、CSS;
- 不重命名 ref(`baseSeqRef` 等出现在几十处注释里,改名要连注释一起改,不值);
- 不动 `App.test.tsx`(9409 行,牵扯每个测试文件各自要 `vi.mock` 的机制;
  等 App.tsx 定型后单开一轮);
- 不拆"舞台 / 右栏"那两坨 JSX(ChatPanel + AdjustmentPanel 40+ props、
  Canvas 20 props)—— 搬它们只是把复杂度换个地方放。

## 验收

- 每批:`npm test` + `npm run typecheck` 两绿;依赖数组逐条对照;`git diff` 人工读一遍。
- 全部做完:真机探针(`scripts/probe-adjust-ledger.mjs` 17 条 + 走一遍
  说一句话 → 生成 → 转盘 → 裁剪 → 撤销 → 刷新恢复)。
- 终点预期:`App.tsx` ≈ 1500 行上下,剩下的就是状态 + 接线。
