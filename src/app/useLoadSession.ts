import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  getSession, listSessions, sessionOriginalUrl, sessionStepUrl,
} from '../api/sessions'
import type { AccountUser } from '../api/account'
import type { DecodedImage } from '../image/decode'
import { clampAdjustments, type Adjustments } from '../../shared/adjustments.ts'
import { normalizeLutRef, type LutRef } from '../../shared/lut.ts'
import type { SuggestCard } from '../../shared/protocol.ts'
import type { ChatMessage } from '../ui/ChatPanel'
import type { Notice } from './useNotice'
import { bitmapsToClose, closeBitmaps, type Snapshot } from '../core/history'
import type { EditState } from '../core/ledger'
import {
  ORIGINAL_PREVIEW_MAX_SIDE, THUMB_MAX_SIDE, makeThumbnail,
} from '../core/thumbnail'
import { TonePipeline } from '../render/pipeline'

/**
 * **恢复会话那一整簇**（★ 2026-10-08 从 `App.tsx` 搬出来）：
 * `loadSession` 本体 + 页面打开时那次"接回上次那条" + 三个只服务它的 ref
 * （`mountedRef` / `loadSeqRef` / `restoreTriedRef`）。
 *
 * ⚠️⚠️ 这是整个 App 里**最贵**的一簇（用户报过、评审查过好几轮的三条
 *   "错了不报错"都在里面）：
 *   · 「用户已经自己动手了」两道闸门（绝对 / 相对，见 `stale`）；
 *   · `idRef` 必须跳过接回来的所有 id（不然新生成那一步整条丢掉）；
 *   · 作废时 `releaseDecoded()` 把位图还回去。
 *   —— 搬的时候一个都没动，写状态的顺序也一字未改。
 *
 * ⚠️ 接口宽（27 个入参）是**这一簇的本来面目**，不是没整理：`loadSession` 干的就是
 *   "把服务端上的一条会话铺回整个 App"——12 个 ref 是 App 的现场，12 个 setter 是
 *   它的落点。`onPick`（换一张照片）写的是同一批东西，但顺序和判据完全不同，
 *   合并不了（那是另一件事，见 `pickStartedRef` 那几段）。
 */
export type LoadSessionDeps = {
  /** 开机那一次"我是谁"问完了没有 —— 挂载时那次恢复要等它。 */
  checking: boolean
  user: AccountUser | null
  /** 选照片的两道闸门 —— App 的 `onPick` 也写它们（"这趟里用户动手了没有"）。 */
  pickStartedRef: { current: boolean }
  pickSeqRef: { current: number }
  pickSettledSeqRef: { current: number }
  /** **底图**换过几版（迟到活儿的总闸门）。 */
  baseSeqRef: { current: number }
  /** 消息 / 版本的发号器 —— 接回来之后必须跳过服务端上那些号。 */
  idRef: { current: number }
  /** "没定稿的那一笔"（上一条会话的，跟着一起作废）。 */
  editPendingRef: { current: { stepId: number; before: EditState } | null }
  /** "哪一版脏了"的落盘待办（接回来的就是服务端那几版，清了）。 */
  dirtyRef: { current: { stepId: number; baseChanged: boolean } | null }
  originalFileRef: { current: File | null }
  setImage: Dispatch<SetStateAction<DecodedImage | null>>
  setParams: Dispatch<SetStateAction<Adjustments>>
  setLut: Dispatch<SetStateAction<LutRef | null>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setCards: Dispatch<SetStateAction<SuggestCard[]>>
  setHistory: Dispatch<SetStateAction<Snapshot[]>>
  setSavedId: Dispatch<SetStateAction<number | null>>
  setCompareSrc: Dispatch<SetStateAction<string | null>>
  setOriginalPreview: Dispatch<SetStateAction<string | null>>
  setBusy: Dispatch<SetStateAction<string | null>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  setCurrentSession: (id: number | null) => void
  moveCursor: (id: number | null) => void
  clearTransient: () => void
  /** 「上次那张要替换掉吗」的问句也一起收（切会话换了一张照片）。 */
  dismissAsk: () => void
  flushEdit: () => void
  flushPersist: (keepalive?: boolean) => void
  noticeBad: (text: string) => void
}

export function useLoadSession(deps: LoadSessionDeps) {
  const {
    checking, user,
    pickStartedRef, pickSeqRef, pickSettledSeqRef, baseSeqRef, idRef,
    editPendingRef, dirtyRef, originalFileRef,
    setImage, setParams, setLut, setMessages, setCards, setHistory, setSavedId,
    setCompareSrc, setOriginalPreview, setBusy, setNotice,
    setCurrentSession, moveCursor, clearTransient, dismissAsk, flushEdit, flushPersist, noticeBad,
  } = deps

  /** 挂载时那次"把上次那条会话接回来"跑过没有。**它保证只跑一次** ——
   *  为什么不能跟着 `user` 每次变都重跑，见下面那个恢复 effect 的注释。 */
  const restoreTriedRef = useRef(false)
  /**
   * 组件还在不在（卸载之后回来的那一趟 `loadSession` 什么都不许写）。
   *
   * ⚠️ **为什么是挂在 ref 上、而不是每趟一个局部 `alive`**：`loadSession`
   *   有两条调用路，其中一条**根本不从 effect 里发起** —— Task 6 的"列表里点开
   *   一条"走的是 `onOpen` 那个点击处理函数，那里没有"某一趟 effect 的局部变量"
   *   可挂。而"树还在不在"是所有路都要问的**同一件事**，所以它必须挂在所有路
   *   都看得见的地方。挂载时置回 true；真正卸载（关页面、测试里 unmount）
   *   之后一直是 false。
   *
   * ⚠️ 它**只管"组件没了"这一件事**。另外两件"这趟不作数"各有各的判据，
   *   别合并：**又开了一趟**看 `loadSeqRef` 那个 `gen`（后到者赢）、
   *   **用户自己动手了**看 pick 那两道判据（都写在 `stale()` 上）。
   *
   * （2026-10-01 Task 6 评审：这一段原来给的理由是"dev 的 StrictMode 重挂载会
   *  把局部 `alive` 放倒、于是恢复整个是死的"—— 那个说法**经不起推敲**：挂载
   *  那两趟 effect 都早早在 `checking || !user` 上 return，既没起过趟、也没登记过
   *  清理。行为是对的（`mountedRef` + `gen` 一起给出"别写死树"和"后到者赢"），
   *  错的是那段理由，换掉留个痕。）
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  /** 接过几次会话。一趟还没回来时用户又开了一趟 —— 前面那趟作废（见 loadSession）。 */
  const loadSeqRef = useRef(0)

  /**
   * 把服务端上的一条会话接回来（spec §6.2）。
   *
   * ★ 2026-10-01（Task 6）从"挂载时恢复"那一段里抽出来的，**两条路走同一份代码**：
   *   挂载时接回**最新那条**（`why: 'restore'`），左栏「对话」里点开某一条
   *   （`why: 'open'`）。抽之前那段只在挂载时跑 —— "点开一条旧会话"是这个列表
   *   存在的全部意义，而它当时**没有任何路径**。
   *
   * ⚠️ **两条路的差别只有三处**，别再多分（多分开一处就会各漂各的）：
   *   ① 「用户已经自己动手了」那道闸门：`'restore'` 用**绝对**判据（手上只要有活儿
   *      就不许盖），`'open'` 用**相对**判据（这趟期间他动了手才作废）。为什么
   *      不能一样：`pickStartedRef` 一旦置位**永不复位**，拿绝对判据去挡"用户自己
   *      点开的那一条"，等于第一次上传之后列表里点什么都**静默无反应**。
   *      ⚠️ 而"相对判据"光看那个布尔是不够的（它单调，选过之后一动不动）——
   *      要比的是 `pickSeqRef` 那个**序号**，理由写在 `stale()` 那两行上。
   *   ② 失败怎么办：`'restore'` 不吭声（用户本来就什么都没做，接不回来就是
   *      "这次从头开始"）；`'open'` 必须说一句，不然就是"点了没反应"。
   *   ③ 接回来时那句话：`'restore'` 要说「这是上次没做完的」（§6.2 明文要求）；
   *      `'open'` **不能说这句** —— 他会读成"我刚点开的这条是上次没做完的那条"，
   *      而他明明点了另一条，那是句假话。
   *
   * ⚠️⚠️ **四件事一件都不能丢**（全是 Task 5 评审一轮一轮抠出来的，都**静默出错**）：
   *   ① `idRef` 跳过接回来的所有 id（下面标了 ★★）；② `dirtyRef`（落盘的待办
   *   记号）清掉 —— 接回来的这几版就是服务端上那几版；③ `pickStartedRef` 那道
   *   闸门；④ 作废时 `releaseDecoded()` 把位图还回去。
   *
   * ⚠️ **写状态那一批里一次 `await` 都不许有**：中途让出的话，落盘那个 effect 会
   *   带着**旧 history + 新 sessionId** 跑一次 —— 那等于**把 A 的活儿写进 B**。
   *
   * ⚠️ **进门第一句就把上一条没落盘的那趟发出去**（`flushPersist`）：切走那一刻，
   *   落盘那层的 800ms 防抖还没到点的话，计时器会被 effect 的清理连根清掉 ——
   *   用户最后改的那几下就永远丢了，而且一句话不说。必须在**改任何状态之前**发，
   *   那时候 `sessionId` 和那份 payload 还都是上一条的。
   */
  const loadSession = useCallback(async (id: number, why: 'restore' | 'open'): Promise<void> => {
    // ★ 第一句，在动任何状态之前（理由见上面那段）
    // ★ 2026-10-08（账本）：**先定稿、再落盘** —— 发出去的那一份（参数 / 滤镜）
    //   得是定稿后的，不然"调完马上切会话"会把最后一笔留成半截。
    if (why === 'open') { flushEdit(); flushPersist() }
    const gen = ++loadSeqRef.current
    /** ★ 选照片的**序号**（不只是"选过没有"的布尔）。见 `pickSeqRef` 那段 */
    const pickSeqAtStart = pickSeqRef.current
    const baseAtStart = baseSeqRef.current
    // 点开那一路要有反馈：那一刻屏幕上要么是空的（底下会露出"选一张照片"那个
    // 上传器 —— 用户会以为这条会话没了），要么还是上一条会话的照片。盖一句话，
    // 别让他对着一屏假画面猜。
    //
    // ⚠️ 顺手把**上一条**留下的通报收掉：通报说的都是"眼前这张照片"的事，
    //   而这张照片马上就要换掉了。最刺眼的一条是恢复那句"这是上次没做完的那张"
    //   —— 它是 `tone: 'ok'`、4 秒才自己走，用户在这 4 秒里点开另一条会话，
    //   这句话就正好挂在**另一张照片**上，读出来是一句假话（§6.2 要防的正是它，
    //   只是方向反了）。点开这条路上没有别的通报要留：接回来了就没什么好说的，
    //   接不回来下面自己会说（`discard` / catch 里的 `noticeBad`）。
    if (why === 'open') {
      setBusy('正在打开这条对话…')
      setNotice(null)
    }

    /** 已经解码、还没交给 history 的位图。**要一次性还清** —— 光还刚解出来的那张，
     *  前面几步的就跟着 `steps` 一起没人管了，它们占的是 GPU 内存。 */
    const steps: Snapshot[] = []
    let released = false
    const releaseDecoded = () => {
      if (released) return
      released = true
      // **按对象去重**：`reusesPrev` 复用的那几步共用同一个位图对象。
      // （2026-10-01 在真 Chrome 里量过：同一个 `ImageBitmap` 连关两次**不抛**，
      //   第二次是空操作 —— 这一层是"数得清"，不是"救得急"。）
      for (const b of new Set(steps.map(s => s.base))) b.bitmap.close()
    }
    /**
     * 这一趟还算不算数。
     *
     * 三种"不算数"，一个都不能少：
     *   · **页面没了**（`mountedRef`）—— 再写就是写到一棵已经不存在的树上；
     *   · **又开了一趟**（`gen`）—— 两趟的写法是"后到者赢"，那先回来的那趟必须闭嘴；
     *   · **这中间用户自己动手了** —— 上面 ① 那两种判据。用户先传了照片，屏幕上
     *     还是"选一张照片"那一屏（什么都没挡住他）；这时候把旧的接回来就是把他刚
     *     传的那张顶掉，而他刚建的那条会话在服务端已经存在（列表里凭空多一条），
     *     两边都不报错。
     */
    const stale = (): boolean => {
      if (!mountedRef.current || gen !== loadSeqRef.current) return true
      return why === 'restore'
        ? (pickStartedRef.current || baseSeqRef.current !== 0)
        // ★ 'open' 是**相对**判据（绝对的话，"上回选过照片"之后用户就再也点不开
        //   任何会话了 —— ★★ 那条用例走的正是"先传过照片、再点开另一条"）。
        //   三句各有各的窗口，缺一句就漏一种：
        //   · 序号变了 = 这趟里**又选了一张**。布尔（`pickStartedRef`）单调，
        //     看不出这个（今天走不到这条路：切会话期间上传器被 `busy` 挡着，
        //     见 `pickSeqRef` 那段 —— 留着当保险）。
        //   · **有一张还在飞**（`pickSeqRef > pickSettledSeqRef`）= 用户手上那张
        //     还没开完。他那会儿 `baseSeqRef` 也还没动，版本号看不出任何变化，
        //     这趟就会把旧会话整段铺上去，过一会儿再被 `onPick` 覆盖回来
        //     （顺带把旧会话那几个位图漏在内存里 —— `onPick` 关的是它闭包里的
        //     那份 `history`）。这条路**今天真的走得通**。
        //   · 底图版本变了 = 那张照片已经开好了（`onPick` 里 `baseSeqRef++`）。
        : (pickSeqRef.current !== pickSeqAtStart
           || pickSeqRef.current > pickSettledSeqRef.current
           || baseSeqRef.current !== baseAtStart)
    }
    /** 作废：位图还回去、日志留痕（**不许静默**）；点开那一路还要说一声。 */
    const discard = (note: string) => {
      releaseDecoded()
      // ★ **被更新的一趟顶掉了不算出错**：用户连点两条会话时，屏幕上正跑着他
      //   刚点的那一条，而这趟只是"慢了一步" —— 这时候还挂一句「这条对话没打开，
      //   再试一次？」是**假话**（什么都没失败），而且挂的是**别人那一屏**。
      //   ⚠️ 位图在上面先还掉了：作废不管哪一种，`steps` 里那些都得关，
      //   早返回不能把那一句也跳过去。
      if (gen !== loadSeqRef.current) return
      console.error(note)
      if (why === 'open') noticeBad('这条对话没打开，再试一次？')
    }

    /**
     * ★ 2026-10-08（账本 Task 8）：恢复这一趟“**离屏重画**”用的那张临时画布 +
     * 一条管线（spec §7.3）。**整趟共用**（≤6 步，几十毫秒级），收尾
     * （成功 / 失败 / 作废**三条路**）在 `finally` 里 `dispose` 还回去。
     *
     * ⚠️ 声明在**这个函数的正文里**、建在下面（拿到详情、"至少有一步"那道闸之后）
     *   —— 两处都是。只在闭包里赋值的写法（把 `new TonePipeline` 塞进 `thumbOf`
     *   里懒加载）会撞上 TS 的一条流分析规则：外层看不到闭包里的赋值，
     *   `finally` 里 `if (offscreen)` 会被收成 `never`。
     * ⚠️ 建不起来（真机上不该发生：浏览器没有 WebGL2）时**不许静默** ——
     *   下面留一行 `console.error`，然后每一步退到"底图直出"
     *   （和"原图预览没取回来"同一档：锦上添花的东西可以没有，但一定要留痕）。
     */
    let offscreen: { canvas: HTMLCanvasElement; pipe: TonePipeline } | null = null

    try {
      const detail = await getSession(id)
      if (stale()) return discard('这条会话没接回来（作废了）：不是页面换了，就是用户自己动手了')
      // 一步都没有 = 这条会话是个空壳（正常到不了这儿：建会话时原图就算一步）。
      // 与其摆一张没有对话、「回到这一步」也点不动的空图，不如照旧让用户自己选。
      // ⚠️ 原来这里是**一声不吭地 return** —— 点了列表却什么都没发生，正是这个
      //   项目最恨的那种失败。留个痕。
      if (detail.steps.length === 0) return discard('这条会话一步都没有，不接（建会话时原图就该算一步）')

      // ★ 2026-10-08（账本 Task 8）：离屏管线在这儿就建（不是等 `thumbOf` 第一次
      //   被叫到才建）—— 循环里**第一张（出生那一步）必然**要画：`reusesPrev`
      //   要"上一步"才成立，而第一步没有上一步。结果一样，少一层懒加载。
      //   建不起来时保持 null（`thumbOf` 逐张退到"底图直出"），**这里要留痕**。
      try {
        const c = document.createElement('canvas')
        offscreen = { canvas: c, pipe: new TonePipeline(c) }
      } catch (e) {
        console.error('恢复时小图的离屏管线没建起来（这几格退回底图直出）', e)
      }

      /**
       * 恢复时**现做**这一步的小图（spec §5 明说服务端不存每一步的缩略图：
       * 「客户端本来就会给每一步生成缩略图，恢复的时候现生成就行」）。
       *
       * ⚠️ 不做的话**同一条对话刷新前后长得不一样**：活着的时候每一格都挂着小图
       *   （`ChatPanel` 的 `thumbs[m.id] &&`），恢复出来只有最后一步有
       *   —— 而且**不报错**，`''` 只是"不渲染"。
       * ⚠️ 它是**锦上添花**那一类（和 `onPick` 里 `setOriginalPreview` 同一个道理）：
       *   做不出来只是这一步的气泡上没有小图，**绝不能让整条会话接不回来**
       *   （那会把可选项升级成必须项）。失败走 console.error，不许静默。
       *
       * ★ 2026-10-08（账本 Task 8）：从"拿**底图**直接缩一张"改成"**底图 +
       *   那一步的参数**离屏重画一遍再缩"。不做的话两条路各说各话：活着时那一格
       *   小图是从**带参数的画面**上抓的，刷新之后每一格都变成"没调过色"的样子
       *   （而且同样不报错）。
       *   ⚠️ **滤镜那层不进这张小图**（spec §7.3 的已知边界）：cube 是异步到手的
       *   （取文件 → 解析），恢复这条路上没有它 —— 所以带滤镜的步骤刷新之后，
       *   小图会少那层颜色（主画面照旧是对的）。
       *   ⚠️ 失败（管线没建起来 / 这一步画不出来）就退到"底图直出"—— **比没有强**
       *   （这一步的气泡上至少还有张图），而且上面已经留过痕。
       */
      const thumbOf = (b: ImageBitmap, p: Adjustments): string => {
        if (offscreen) {
          try {
            offscreen.pipe.setImage({ bitmap: b, width: b.width, height: b.height })
            offscreen.pipe.resizeToImage()
            // ⚠️ 只传 params、不传 lutAmount：滤镜那层不在这一趟里（见上面那段）。
            offscreen.pipe.render(p)
            return makeThumbnail(offscreen.canvas, THUMB_MAX_SIDE)
          } catch (e) {
            console.error('恢复时小图没做出来（退回底图直出）', e)
          }
        }
        // "底图直出"本身也可能做不出来（连 2D 上下文都拿不到）—— 那一步的小图
        // 就是 `''`（不渲染）。**这一层的失败不能再抛出去**：它会把整条会话的
        // 恢复带塌（上面那段 ⚠️ 说的就是这件事）。
        try { return makeThumbnail(b, THUMB_MAX_SIDE) } catch { return '' }
      }
      // 每一步都要解码回位图。⚠️ `reusesPrev` 是真的能省一次下载 + 一次解码：
      // 拖十次滑块就是十步，一步步全下就是十个一模一样的文件。
      //
      // ★ `params` 必须过 `clampAdjustments`（2026-10-04，「专业面板」Task 6）——
      //   **老数据缺新键**：今天之前存进库里的步骤只有那八根，新加的七条取出来是
      //   `undefined`。归一化是唯一入口，别让 `undefined` 进状态 —— 进了就是面板
      //   七根滑块落不到 0、色轮算成 `NaN`、落盘照旧缺着七个键（全都不报错）。
      //   两条 `push` 是同一批数据的两个入口（`reusesPrev` 那条也一样），都要走。
      // ★ 2026-10-08（账本）：恢复出来的每一版**账本清空** —— 每版只剩当前位置
      //   一笔（设计 §5.6：账本和位置一样不落盘）。下面两处 `push` 都给空数组。
      for (const s of detail.steps) {
        const prev = steps.at(-1)
        if (s.reusesPrev && prev) {
          // 和上一步是**同一张图**，小图直接接着用（重做一遍只会得到像素级不同、
          // 肉眼一样的两张 —— 而这正是"刷新前后长得不一样"里最没必要的一种）。
          // ★ 2026-10-05：`lut` 走 `normalizeLutRef`（老步骤没有这个键 = 没用滤镜），
          //   和 params 过 `clampAdjustments` 同一条规矩 —— 归一化是唯一入口。
          steps.push({ id: s.id, label: s.label, base: prev.base,
                       params: clampAdjustments(s.params), lut: normalizeLutRef(s.lut),
                       isOriginal: false, thumb: prev.thumb, prompt: s.prompt,
                       past: [], future: [] })
          continue
        }
        const blob = await (await fetch(sessionStepUrl(detail.id, s.id))).blob()
        const bitmap = await createImageBitmap(blob)
        if (stale()) { bitmap.close(); return discard('恢复：这次接回来的已经不作数了（页面换了，或者用户自己动手了）') }
        // ⚠️ 归一化**只做一次**、存进局部量：`params` 既进快照、又是小图离屏
        //   重画的入参（★ Task 8）—— 两处各 `clampAdjustments` 一遍的话，
        //   明明该是同一份东西，却是两个对象（以后谁把 `sameEdit` / 引用比较
        //   用在这一版上，就会被这种"值一样、身份不一样"咬到）。
        const params = clampAdjustments(s.params)
        const lut = normalizeLutRef(s.lut)
        steps.push({ id: s.id, label: s.label, params, lut,
                     base: { bitmap, width: bitmap.width, height: bitmap.height },
                     isOriginal: steps.length === 0, thumb: thumbOf(bitmap, params), prompt: s.prompt,
                     past: [], future: [] })
      }
      const lastStep = steps[steps.length - 1]!

      // 「按住看原图」那张预览要从**原图**重新生成一次（它本来是内存里的 data URL）。
      //
      // ★ 顺手把 `originalFileRef` 也补上 —— 这一步**不是可选的锦上添花**：
      //   「保存 / 分享 / 下载」三条路的门口都有一句
      //   `if (!canvasElRef.current || !originalFileRef.current) return`，
      //   而恢复出来的会话手里原来**没有**这个 File —— 三颗按钮会一起
      //   "点了没反应"，不报错、也不提示。
      //
      //   ⚠️ 别去松那三处的守卫（那是治症状）：`exportCurrent` 要这个 File 是
      //   做两件**真事** —— `buildExportBlob(canvas, file, …)` 拿它写回 EXIF，
      //   `buildFilename(file.name, …)` 决定下载下来的文件叫什么。松掉守卫换来
      //   的是"导出能成，但没 EXIF、名字还叫 `_pinkrose.jpg`" —— 比"没反应"更坏，
      //   因为它不报错、也不明显。这里补上真正的那个 File，那三处从"错的"变成
      //   "对的"，一个字都不用改。
      //
      // ⚠️⚠️ 但**这一份 File 里没有 EXIF**，和用户真传的那张不一样。服务端存的
      //   `original` 是 `bitmapToDataUrl` 编出来的，中间过了一次 `<canvas>` ——
      //   而 canvas 编码**不携带 EXIF**（拍摄时间、GPS 在那一步就没了）。
      //   所以恢复出来的会话导出时，`withExif` 读到的是**一份空的 EXIF**，
      //   产出的是一张普通 JPEG：不报错，只是那些信息本来就没有。
      //   活的会话（没恢复过的）照旧是准的 —— 用户真那个 File 还在内存里。
      //   要补上得让服务端另存一份**原始字节**，那是另一件事，别在这儿假装它还在。
      let originalBack = true
      try {
        const ob = await (await fetch(sessionOriginalUrl(detail.id))).blob()
        // ⚠️ 这一趟网络往返里用户同样可能自己动手了 —— 再往下就是**直接改他的
        //    `originalFileRef` 和屏幕上的预览**（`setOriginalPreview`），写错了
        //   是"照片是新传的、导出的却是旧的"这种看不出来的错。
        if (stale()) return discard('这条会话没接回来（作废了）：不是页面换了，就是用户自己动手了')
        const oi = await createImageBitmap(ob)
        // ⚠️ `close()` 必须在 `finally` 里：`makeThumbnail` 抛（拿不到 2D 上下文）
        //   的时候，写在下一行的那个 `oi.close()` 根本轮不到 —— 那张位图会一直
        //   占着 GPU 内存，而且这恰恰是**异常路径**，平时没人会盯着它。
        try {
          setOriginalPreview(makeThumbnail(oi, ORIGINAL_PREVIEW_MAX_SIDE))
        } finally {
          oi.close()
        }
        // 名字用用户上传时那个（spec §6.3 / §6.4）。没有名字就兜一个 ——
        // 空名字会让 `buildFilename` 产出 `_pinkrose.jpg` 这种没法看的文件名。
        originalFileRef.current = new File(
          [ob], detail.originalName?.trim() || '照片.jpg', { type: ob.type || 'image/jpeg' })
      } catch (e) {
        // ⚠️ 上面那两件事的**重要性不一样**，所以这个 catch 只说得起其中一件：
        //   预览没了只是少了「按住看原图」；而 `originalFileRef` 没了，
        //   保存/分享/下载会**一起静默失效**（见上面那段）。真到那一步要让用户知道。
        originalBack = false
        // ⚠️ 预览要**抹掉**：留着的是上一条会话那张原图（点开另一条会话时），
        //   而「按住看原图」会把它当成**这一条**的原图给用户看 —— 一张别人的照片。
        setOriginalPreview(null)
        console.error('原图没取回来（预览和保存/分享/下载都会受影响）', e)
      }

      // ★★ 下面这一批**必须一次写完**（中间一次 await 都没有）——
      //    中途让出的话，落盘那个 effect 会带着**旧 history + 新 sessionId** 跑一次：
      //    那等于把 A 的活儿写进 B。App.test.tsx 里有一条测试钉着它。
      // ★ 2026-10-08（账本）：上一条会话那个"没定稿的半截笔"跟着一起作废 ——
      //   history 马上整份换掉，留着它只会堵住下一次"起一笔"（`flushEdit` 找不到
      //   那个 id、白跑一拍）。和下面那次 `closeBitmaps` 是同一批。
      editPendingRef.current = null
      setHistory(prev => {
        // 切走的这条会话的位图要还回去（含它的原图）。不还就是"切几次把标签页拖垮"
        // —— 每张原图按 32 MP 算是 129 MB 的 GPU 内存。
        // ⚠️ 用 updater 里那个 `prev`，不用外面那个 `history`：这里要的是**真正被
        //   换掉的那一份**，而且 updater 里的写法不依赖闭包抓到的是哪一轮的 history。
        //    （`close()` 幂等，StrictMode 重放这个 updater 也安全。）
        closeBitmaps(bitmapsToClose(prev, []))
        return steps
      })
      setImage(lastStep.base)
      setParams(lastStep.params)
      // ★ 2026-10-05（滤镜）：最后一步的滤镜跟着回来。
      //   ⚠️ `?? null` 那半不是多余的：`SessionStep.lut` 是**可选**的（老会话
      //   没有这个键，服务端给的是显式 null，但"直接手搓的详情"可能真是 undefined）
      //   —— 漏了它，`lut` 会变成 `undefined` 而不是 null，后面每一处 `lut?.lutId`
      //   都还是安全的，但**类型上已经不是 `LutRef | null` 了**，别让它在状态里过夜。
      setLut(lastStep.lut ?? null)
      // ★ 2026-10-05：恢复出来人站在**最新一步**（和 `setImage(lastStep.base)`
      //   是同一件事的两面）。"站的位置"不落盘（设计 §9）：刷新后回到最新。
      //   ⚠️ 走 `moveCursor`（state + 影子 ref 一起写）—— 别写回 `setCursorId`。
      moveCursor(lastStep.id)
      setMessages(detail.messages)
      // ★ 走 `setCurrentSession` 那道门（影子和 state 一起改，见它的注释）——
      // 这行在 'open' 那趟里改的正是"现在人站在哪条会话上"，而落盘的应答
      // 回来时要拿那个影子比对。
      setCurrentSession(detail.id)
      // 上一条照片那些**临时**状态跟着一起清（和 `onPick` 里换图时清的是同一批，
      // 同一个道理 —— 点选流程、"替换上次那张"的问句；两条后果见 `clearTransient`）。
      // ⚠️ 切会话那半尤其要命：不清的话"要切掉后面吗"会停在**别人那条**会话上
      //   （N 还是按新的 history 算的，读数都不对），点「继续改」切的是别处。
      clearTransient()
      setSavedId(null)
      dismissAsk()
      // ★ 2026-10-06（对比）：同一批 —— 备的是**上一条会话**那张原图，
      //   切过来之后按「对比」会拿它当**这一条**的原图给用户比（一张别人的照片，
      //   而且不报错）。下一次按「对比」时按这一条重新备。
      setCompareSrc(null)
      // 建议卡片也不留：它是照着**上一张**照片算出来的，点一下就是花钱去改
      // 一件在这张照片上根本没发生的事。
      setCards([])
      // ★★ 本地那个 id 计数器要**跟着跳到接回来的这些号之后**（2026-10-01 评审抓到）。
      //   每个会话的 id 都从 1 开始（欢迎语 = 1，而它同时就是第 1 步的 id ——
      //   `onPick` 里那个 `say()` 拿到的号给了消息和快照两边），而 `idRef` 每次
      //   挂载都从 0 重来。不同步的后果都是**真 id 上的碰撞**：
      //     · 用户恢复之后说的第一句话拿到 id 1 —— 和接回来的那条欢迎语重号
      //       （`ChatPanel` 的 `key={m.id}`，dev 里 React 直接警告）；
      //     · 助手那条拿到 id 2 —— 只要旧历史里有个 id 2 的步骤，**新生成的那一步
      //       就和它同一个 id**。而服务端 `mergeSteps` 是按 id 对齐的：旧的那条
      //       被推两遍，**用户刚花钱生成的那一步整条丢掉**，刷新就没了；
      //       「回到这一步」/「再来一版」也都会拿到旧的那条（`history.find` 取的
      //       是**第一个**同 id 的）—— 跳到旧图、重跑旧 prompt，又是一次真花钱。
      //   一次 `Math.max` 就够：id 只会往前长。`detail.steps` 非空（上面那道闸门
      //   挡过了），所以这个展开至少有一个数。
      idRef.current = Math.max(
        idRef.current,
        ...detail.messages.map(m => m.id),
        ...detail.steps.map(s => s.id),
      )
      // ★ 底图**换过一版了**（从 A 的换成 B 的）—— 记号往前挪一格。
      //   ⚠️ 这个 `++` 随手管住两件"迟到的活儿"：上传时那批**建议卡片**和
      //      十几秒前那次**生成**。它们回来时发现底图版本变了，就会自己作废 ——
      //      不作废的话，A 的卡片 / A 生成的那张图会**落进 B**（`loadCards` 那道闸门
      //      看的正是这个版本号）。
      // ★ 2026-10-08（账本）：**上一条的待办记号一起作废** —— 刚接回来的这几版
      //   **就是服务端上那几版**，别一进来就把它重传一次（不记的话：下一次落盘
      //   会带着 `base` 上路，而服务端每收一次 `base` 就存成一个新文件 ——
      //   每条会话白白多背一张没人引用的全尺寸图，还白传一趟）。
      //   这里替代了原来那句 `lastPersistedBaseSeqRef.current = baseSeqRef.current`
      //   （那个记号已随 Task 7 退役：今天"服务端已经有了"这件事由**没有待办**
      //   来表达，见 `dirtyRef`）。
      //   ⚠️ 和上面 `editPendingRef.current = null` 是同一批（LIFO：两样都是
      //      "上一条会话的、没结完的账"，跟着 history 一起换掉）。
      baseSeqRef.current++
      dirtyRef.current = null
      // ⚠️ 两条通报**只有一格**（`notice` 是一个对象）：上面 catch 里那句
      //   "原图没取回来"先设、这里再无条件设一句，同一个批次里**后设的赢** ——
      //   用户只会看到"接着改就行"，而那一刻「保存」「分享」「下载」其实是坏的。
      //   所以两条合成一句：坏的那半留着（它带着动作），"上次那张"那半也不能丢
      //   （§6.2 要的那句话，这时候更不能省 —— 正是它告诉用户照片不是刚传的）。
      // ⚠️ 三颗按钮都要点名，不能只说「保存」「下载」：能分享的设备上，用户看到的
      //   那颗叫「分享」，漏了它就是"说的是屏幕上没有的那颗按钮"。
      // ⚠️ 点开那一路**不说"上次"那句**（理由见函数头 ③），但坏消息照说 ——
      //   它是真的，而且带着动作。
      const bad = '原图没取回来，「存进作品」「分享」「下载」可能用不了，刷新一下试试。'
      if (why === 'restore') {
        setNotice(originalBack
          ? { text: '这是上次没做完的那张，接着改就行。', tone: 'ok' }
          : { text: `这是上次没做完的那张，接着改就行。不过${bad}`, tone: 'bad' })
      } else if (!originalBack) {
        setNotice({ text: `这条对话打开了，不过${bad}`, tone: 'bad' })
      }
    } catch (e) {
      // 半路炸了：**这一趟解码出来的位图要还回去**（不然就漏在内存里没人认领）
      releaseDecoded()
      console.error(why === 'restore' ? '上次那条没接回来' : '这条会话没打开', e)
      // 挂载那一路不打扰用户：接不回来就是"这次从头开始"，而他本来就什么都还没做。
      // 点开那一路必须说 —— 不然就是点了没反应。
      // ⚠️ 但**被更新的一趟顶掉**的那一趟不在此列：屏幕上正跑着用户刚点的那条，
      //   这句"没打开"说的是他已经不在乎的那一条，而且它没有失败（见 `discard`）。
      if (why === 'open' && gen === loadSeqRef.current) noticeBad('这条对话没打开，再试一次？')
    } finally {
      // ★ 2026-10-08（账本 Task 8）：恢复这一趟的**离屏小图管线**在这里还回去 ——
      //   `finally` 一次管住**三条路**（成功回来 / 中途抛 / 作废早返回时的 discard）。
      //   不收的代价是每次恢复漏一张画布 + 一条管线 + 一个 WebGL 上下文，
      //   而且一句错都不报（这条 path 上一堆早返回，写在某一处就是漏别的某处）。
      if (offscreen) { offscreen.pipe.dispose(); offscreen = null }
      if (why === 'open') setBusy(null)
    }
  }, [flushEdit, flushPersist, noticeBad, setCurrentSession, moveCursor, clearTransient])

  /**
   * 打开页面之后，把"上次那条会话"接回来（spec §6.2）。
   *
   * ⚠️ 必须排在 `me()` 那一次之后 —— 要登录态。摆在前面的两句是同一个道理：
   *   没问出"我是谁"就出门，恢复那一路会拿着 401 回来。
   * ⚠️ **只在登录之后跑一次**（`restoreTriedRef`）。依赖里那个 `user` 变起来并不
   *   稀罕：票中途失效 → 回登录页 → 重新登录，走的就是"置空 user、再填回来"
   *   （见 isUnauthorized 那段：那条路**故意不卸载 App** —— 重新登录之后用户
   *   还没存完的活儿原样还在）。跟着它重跑一遍恢复，等于拿服务端上那一份
   *   **盖掉他手上这一份**：上一次落盘失败的那一步、或者刚改完还没到防抖点的那
   *   一版，会当场消失，而且一句话都不说 —— 正是这个项目最恨的那种失败。
   *
   * ⚠️ 接回来的东西要**说一句**"这是上次没做完的"（§6.2）。不说的话用户会以为
   *   照片是刚上传的 —— 那是句假话，而这一版存的成本全是为了少说假话。
   *
   * ⚠️ "取列表、拿第一条、交给 loadSession" 这三步**只有这一处**：点开列表里
   *   某一条走的是同一个 loadSession（Task 6 抽出来的），两条路的写法不许分家。
   */
  useEffect(() => {
    if (checking || !user || restoreTriedRef.current) return
    restoreTriedRef.current = true
    void (async () => {
      try {
        const list = await listSessions()
        // 列表是服务端按 `updated_at` 倒序给的（§5），第一条就是"上次动过的"。
        if (!mountedRef.current || list.length === 0) return
        await loadSession(list[0]!.id, 'restore')
      } catch (e) {
        console.error('上次那条没接回来', e)
        // 不打扰用户：接不回来就是"这次从头开始"，而他本来就什么都还没做
      }
    })()
  }, [checking, user, loadSession])

  return { loadSession }
}
