import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useLuts } from './useLuts'
import type { DecodedImage } from '../image/decode'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { Snapshot } from '../core/history'
import type { EditState } from '../core/ledger'

/**
 * 滤镜那一摊里**跟着 App 状态走**的那半（★ 2026-10-08 从 `App.tsx` 搬出来）：
 *
 *   · 「当前用的滤镜没了」的唯一处理处（`dropGoneLut`）；
 *   · 重新拉清单 + 照镜子（`refreshLuts`，离开 `/app/luts` 时叫一次）；
 *   · 「打开滤镜那一栏」那一刻的一次性行为（`needLutThumbs`）；
 *   · 以及 `refreshLuts` 照镜子要用的那个影子（`lutRef`）。
 *
 * ⚠️ 清单 / cube / 缩略图那一摊**不在这里** —— 那是 `app/useLuts` 的活，App
 *   自己拿着跑（面板、生成、交付几处都要它的产物）；这里只是接它的 `lutsApi`。
 */
export type LutFlowDeps = {
  lut: LutRef | null
  setLut: Dispatch<SetStateAction<LutRef | null>>
  lutsApi: ReturnType<typeof useLuts>
  image: DecodedImage | null
  params: Adjustments
  noticeBad: (text: string) => void
  /** 「当前这一版」的影子 —— `dropGoneLut` 要把落盘账挂到它指的那一版上。 */
  cursorIdRef: { current: number | null }
  /** **没定稿的那一笔** —— 扫死滤镜时连它一起扫（见 `dropGoneLut` 里那段）。 */
  editPendingRef: { current: { stepId: number; before: EditState } | null }
  setHistory: Dispatch<SetStateAction<Snapshot[]>>
  markDirty: (stepId: number, baseChanged: boolean) => void
}

export function useLutFlow(deps: LutFlowDeps) {
  const {
    lut, setLut, lutsApi, image, params, noticeBad,
    cursorIdRef, editPendingRef, setHistory, markDirty,
  } = deps

  /**
   * `lut` 的**影子**。只为 `refreshLuts` 照镜子时用：那个回调挂在"离开
   * `/app/luts`"那个 effect 上，把 `lut` 放进它的依赖数组就等于**每选一次滤镜
   * 都重建它**（连带那个 effect 跟着重跑）—— 而它要的只是"**跑的时候**当下是哪个"。
   */
  const lutRef = useRef<LutRef | null>(null)
  useEffect(() => { lutRef.current = lut }, [lut])

  /**
   * ★ 2026-10-05（滤镜）：「当前用的滤镜没了」—— **唯一**处理它的地方
   * （离开设置里那一页、刷新完清单之后照一次镜子，设计 §6.4 客户端那半）。
   *
   * 三件事**一起**做，少一件都是"错了不报错"：
   *   · 清状态 —— 不清的话画面上还照着那个 cube 调色，而 cube 是缓存里那份；
   *   · **把历史里那几步也清掉** —— 历史是本地的真相（画布、小图、跳回去都看它），
   *     留着一个**已经不存在的 id** 在里头，就是让本地这份数据自己不自洽；
   *     （⚠️ 服务端那边有 `resolveLutRef` 兜着，悬空 id 进不了库 —— 所以这条
   *      **不是**在防"把死 id 写回服务端"，而是在防"客户端自己的 state 走岔了"。
   *      2026-10-05 审查更正过一次：之前的注释把服务端那半说重了。）
   *   · 说一句 —— 用户眼前的照片少了一层颜色，不说就是悄悄改了他的图。
   */
  const dropGoneLut = useCallback((id: number) => {
    setLut((cur) => (cur?.lutId === id ? null : cur))
    // ★ 2026-10-08（账本）：**账本里的笔也要扫一遍** —— `past` / `future` 里那些
    //   笔是"当初套着这个滤镜"的画面状态，留着的话退回去会套一个**已经被用户
    //   删掉**的滤镜：cube 取不到、画面上那层颜色说没就没（而且不报错）。
    //   三处（当前位置 + past + future）是同一件事的三份拷贝，改一处就得三处一起。
    //   ★ 2026-10-08（Task 5 顺手件）：**排队中等定稿的那一笔也要扫** ——
    //   `editPendingRef` 里那份"改之前"还没进 `history`，上面那三处扫不到它；
    //   等 0.8 秒后定稿，那个死 id 会被压进 `past`，退回去照样套回死滤镜（同一个
    //   病，只是走的是"账本还没收的那一笔"这条路）。这里把那一份的 `lut` 也置空
    //   —— ⚠️ 只置空 **lut**、不丢整笔待办：那一笔里的 params 是用户刚调的东西，
    //   丢了就是"这一下退不回去"（`settleLedger` 那套回收也没了依据）。
    const pend = editPendingRef.current
    if (pend && pend.before.lut?.lutId === id) {
      editPendingRef.current = { ...pend, before: { ...pend.before, lut: null } }
    }
    setHistory((prev) => prev.map((s) => ({
      ...s,
      lut: s.lut?.lutId === id ? null : s.lut,
      past: s.past.map((p) => (p.lut?.lutId === id ? { ...p, lut: null } : p)),
      future: s.future.map((f) => (f.lut?.lutId === id ? { ...f, lut: null } : f)),
    })))
    // ★ 2026-10-08（账本 Task 7）：**这一版的"现在"变了** —— 那层颜色是从快照上
    //   摘掉的，落盘得认这笔账。不记的话服务端那份还挂着这个已经不存在的 id：
    //   客户端这边靠"每次挂载照一次镜子"自愈，服务端那边则一直没发生 —— 正是
    //   "错了不报错"那一类（老代码是靠无条件送 params/lut 顺带盖住的）。
    //   ⚠️ 挂**当前这一版**（`cursorIdRef`）：`stateStepId` 一趟只能指一步，而
    //   "现在这一版"才是用户眼前这套颜色。上面那个 `map` 顺手扫过的 `past` /
    //   `future` 不落盘（账本不落盘，设计 §8）。
    //   ⚠️ `cursorIdRef.current === null`（没有照片）= 这一趟没有会话可写。
    const cur = cursorIdRef.current
    if (cur !== null) markDirty(cur, false)
    noticeBad('那个 Lut 刚被你删掉了，这张照片上的也去掉了。')
  }, [setLut, editPendingRef, setHistory, cursorIdRef, markDirty, noticeBad])

  /**
   * 重新拉一遍清单，然后照镜子（离开 `/app/luts` 时叫一次）。
   *
   * 为什么非得拉一次：那一页上刚导入的滤镜要**立刻能用**、刚删的要**立刻消失**，
   * 而清单是 App 挂载时拉的那一份。
   *
   * ⚠️ 读当下的 `lut` 用的是**影子**（`lutRef`），不是把它写进依赖：写进去的话
   * 这个回调和挂在它上面的那个 effect 会跟着**每一次选滤镜**重建/重跑一遍。
   *
   * ★ 2026-10-05 终审修复：`reloadLuts()` 回 **`null` = 这次没问出来**（离线 / 5xx /
   *   后端刚重启）—— 那一刻**什么都不许照**。照空数组的下场很具体：用户在那
   *   一页上什么都没删，只是点离开，却被他手上那层滤镜被清掉 + 听到一句
   *   「那个滤镜刚被你删掉了」（而清单里那条明明还在）。"真的没有了"是
   *   **拿到清单、里面确实没有它**，不是"没拿到清单"。
   */
  const refreshLuts = useCallback(async () => {
    const list = await lutsApi.reload()
    if (list === null) return                // 没问出来 → 照旧，什么都不动
    const cur = lutRef.current               // 用一个 ref 读当下那个 id，别把它写进依赖
    if (cur && !list.some((l) => l.id === cur.lutId)) dropGoneLut(cur.lutId)
    // ⚠️ 依赖写 `lutsApi.reload` 那个**稳定身份**（`useCallback([])`），不写整个
    //   `lutsApi` —— 后者是每次渲染新造的对象，写进去这个回调和挂在它上面的
    //   effect 会每次渲染都重跑一遍（理由见 App 里 `reloadLuts` 那段）。
  }, [lutsApi.reload, dropGoneLut])

  /**
   * 「打开滤镜那一栏」那一刻叫一次（微调区和对话区两个宿主共用这一份行为）。
   *
   * 两件事：
   *   · 缩略图 —— 很贵（每个滤镜各画一张当前照片），收着时白画是纯浪费；
   *   · ★ 2026-10-05 终审修复：清单**还没到手过**就顺手重拉一次。App 挂载那一次
   *     `listLuts()` 失败（离线 / 后端刚重启 / 页面里重新登录过）之后，不点这一下
   *     用户手上就一直没有清单，而面板上挂着的是"还没有导入过滤镜"那句假话。
   *     重拉再失败也没关系：面板那边有 `lutsKnown`，说的是中性的话 + 一颗重试。
   */
  const needLutThumbs = () => {
    if (!lutsApi.lutsKnown) void lutsApi.reload()
    lutsApi.ensureThumbs(image, params)
  }

  return { refreshLuts, needLutThumbs, dropGoneLut }
}
