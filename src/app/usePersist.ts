import { useCallback, useEffect, useRef } from 'react'
import { updateSession, type SessionPatch } from '../api/sessions'
import { GALLERY_THUMB_MAX_SIDE, bitmapToDataUrl, makeThumbnail } from '../core/thumbnail'
import { pushEdit, sameEdit, settleLedger, type EditState } from '../core/ledger'
import type { Snapshot } from '../core/history'
import type { ChatMessage } from '../ui/ChatPanel'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'

/**
 * **落盘那一整簇**（★ 2026-10-08 从 `App.tsx` 搬出来）：调色那一笔的定稿
 * （`flushEdit`）、防抖 800ms 把"现在这一趟"存回服务端、以及"页面要走了"
 * 那两条 keepalive 的路（`flushPersist`）。
 *
 * 搬出来的是**互相咬合的四件**（分开搬任何一件都会留下一个半拉子）：
 *   · `editPendingRef`（没定稿的那一笔，App 拿着、`flushEdit` 用）；
 *   · `dirtyRef`（"哪一版脏了"的待办，App 拿着、这里读/销）；
 *   · 800ms 防抖那个 effect（`run` 的全部 + 登记到 `pendingPersistRef`）；
 *   · `flushPersist` 与 `pagehide` / `visibilitychange` 两个出口。
 *
 * ⚠️ 搬的时候依赖数组一个都没改（`[history, messages, params, lut, sessionId, cursorId]`）
 *   —— 那六条里每一条都各有一段"删了就静默出错"的历史，见 effect 尾巴上那段。
 */
/**
 * 落盘那趟在"页面正在消失"时敢不敢用 `keepalive` 的**体量上限**（字节）。
 *
 * 浏览器对 keepalive 的请求体有 **64 KiB 的硬上限**，超了 fetch 会被**当场拒绝**
 * —— 那比普通 fetch 还差（普通 fetch 至少"可能发得完"，被拒是必然发不出）。
 * 所以调用点先量一下，超了就退回普通 fetch（见 `run` 里那段）。
 * 取 60000 而不是 65536：给 JSON 头尾和将来加的字段留一点，别卡在边界上。
 *
 * ⚠️ 两种体量分得很开，这个数取中间哪都行：说一句话 / 拖滑块 ≈ 几 KB；
 * 带一整张底图（base64）≈ 一两 MB，必然超。
 */
const KEEPALIVE_MAX_BYTES = 60_000

export type PersistDeps = {
  history: Snapshot[]
  messages: ChatMessage[]
  params: Adjustments
  lut: LutRef | null
  sessionId: number | null
  /** `sessionId` 的影子 —— 应答回来时要问"我**现在**还是不是当时那条会话"。 */
  sessionIdRef: { current: number | null }
  cursorId: number | null
  /** **哪一版的"现在"变了**（App 拿着；`flushEdit` 与这里都读它）。 */
  dirtyRef: { current: { stepId: number; baseChanged: boolean } | null }
  /** **没定稿的那一笔**（App 拿着；`flushEdit` 是它唯一的出口）。 */
  editPendingRef: { current: { stepId: number; before: EditState } | null }
  /** 账本发号器（App 拿着）：定稿那一笔的 `seq` 从这儿发。 */
  editSeqRef: { current: number }
  setHistory: (fn: (h: Snapshot[]) => Snapshot[]) => void
  /** 屏幕上那块画布 —— 封面（`thumb`）照旧从它抓。 */
  canvasEl: { current: HTMLCanvasElement | null }
  noticeBad: (text: string) => void
}

export function usePersist(deps: PersistDeps) {
  const {
    history, messages, params, lut, sessionId, sessionIdRef, cursorId,
    dirtyRef, editPendingRef, editSeqRef, setHistory, canvasEl, noticeBad,
  } = deps

  /**
   * 把没定稿的那一笔记进账本。**没有待办 = 空操作**（重复调用无害）。
   *
   * "之后"取**快照里的现场值**（`s.params` / `s.lut`）——写回那条 effect 一直在
   * 把它们镜像成最新，所以快照上那一份就是"改之后"。⚠️ 也**只能**这么取：
   * 闭包里的 `params` / `lut` 是"这个回调被创建时"的值，而它经常跑在定时器里
   * （那一刻闭包早就是过去某一轮的了）。
   *
   * ⚠️ **净零不记**（spec §5.1）：拖走又拖回原值，账本上不留一条空笔（留了的话
   *   用户要按两下箭头才回到他真正想去的地方）。
   * ⚠️⚠️ 净零和"找不到那一版"两条**都返回原来那份 `h`**，不是 `h.map(...)` 出来的
   *   新数组 —— 引用相等，React 才会跳过重渲染。返回新数组的代价是**真的**：
   *   落盘那个 effect 的依赖里有 `history`，它会跟着重跑一遍、重新立一个 800ms
   *   的闹钟，于是**白白多发一趟一模一样的 PUT**（2026-10-08 实测：`说一句话
   *   （模型给的增量是空的）→ 切会话` 那条 App 用例当场红 —— 多出来的那趟打的
   *   还是**上一条会话**的 id）。
   * ⚠️ deps 是**空的**：它只读 ref、只用 `setHistory`（身份稳定）。
   * ★ Task 5：这条路的后面接上了预算闸（`settleLedger`）—— ⚠️ **但要接在
   *   "确实记了一笔"之后**：上面那两个早返回（净零 / 那一版不在了）之后
   *   一步都不许走，连数组都不许换新的（见上面那条 ⚠️⚠️）。
   */
  const flushEdit = useCallback(() => {
    const p = editPendingRef.current
    if (!p) return
    editPendingRef.current = null
    // ★ 号**在 updater 外面发**（2026-10-08 评审顺手件）：`setHistory` 的 updater
    //   会被推迟到渲染时才跑、StrictMode 还会重放 —— 写在里面的话，"先发生的
    //   那一笔"可能拿到**更大**的号，而 Task 5 的预算驱逐正是按 `seq` 挑"最老的
    //   一笔"（挑反了就是把新的丢了、留着老的）。
    //   ⚠️ 代价是净零 / 找不到那一版时也白跳一个号 —— **无害**（号允许有空洞，
    //   它只用来比先后，不参与任何显示）。
    const seq = ++editSeqRef.current
    setHistory(h => {
      const s = h.find(x => x.id === p.stepId)
      // 那一版已经不在了（被删了 / 换了会话）：原样返回，一个字节都不动。
      if (!s) return h
      // ⚠️ 这里**不能**用闭包里的 `params`：定时器到点时那是过去那一轮的值。
      const next = { base: s.base, params: s.params, lut: s.lut }
      if (sameEdit(p.before, next)) return h         // 净零：不记（也不惊动渲染）
      const withEdit = h.map(x => (x.id === p.stepId ? pushEdit(x, { ...p.before, seq }, next, seq) : x))
      // ★ Task 5：记完这一笔 → 过预算闸 + 回收位图（调色笔零成本，闸多半什么都不动）
      return settleLedger(h, withEdit)
    })
  }, [])

  /** 落盘的次序号。后一次回来时前一次可能还在路上 —— 只认最新的那一次 */
  const persistSeqRef = useRef(0)
  /**
   * **还没到点**的那一趟落盘：它的活儿（`run`）和那个 800ms 的闹钟。
   *
   * ⚠️ 为什么要单独记着它：防抖那个计时器是挂在落盘 effect 的清理里的，而清理
   *   在依赖一变（`sessionId` 就在依赖里）就跑 —— 用户改完立刻切会话的话，
   *   这个闹钟**连响的机会都没有**，上一条会话最后那几秒的改动就永远丢了，
   *   而且一句话都不说（这个项目最恨的那种失败）。
   *   所以切走那条路上要能**手动把它提前点掉**，见 `flushPersist`。
   */
  const pendingPersistRef = useRef<{
    run: (keepalive?: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  /**
   * 把**还没到点**的那趟落盘立刻发出去（防抖窗口里被打断时用）。
   *
   * ⚠️ 得在**改状态之前**调：它拿的是当初那个 effect 闭包里的一份 payload 和
   *   **那一条的 `sessionId`** —— 状态一改，那份 payload 就已经是"上一条"的了，
   *   而这时候再发正是我们要的（把它写完再走）。
   * ⚠️ 先摘掉再发：不摘的话闹钟到点还会再发一遍，同一句话写两次。
   * ★ `keepalive`：页面**正在消失**时才传 true（`pagehide` / 切到后台那两条路）——
   *   普通 fetch 会在卸载时被掐断。它到底怎么用、什么体量不能用，见 `run` 里那段。
   */
  const flushPersist = useCallback((keepalive = false) => {
    const p = pendingPersistRef.current
    if (!p) return
    pendingPersistRef.current = null
    clearTimeout(p.timer)
    p.run(keepalive)
  }, [])

  /**
   * 把"现在这一趟"存回服务端。
   *
   * ⚠️ 五件事，一件都不能错：
   *   ① **防抖**：拖一次滑块会推出很多版 —— 不防抖就是每个像素一次 PUT。
   *   ② **不许在底图没换的时候传 `base`** —— 那会多存一个没人引用的文件
   *      （设计文档 §4.3 那条"参数步不产生新图"，落点就在这儿）。
   *   ③ **不许在调用点上 await** —— 用户拖滑块是连续的，等一次网络往返就等于拖不动。
   *   ④ **不许把失败吞掉** —— 静默失败是这个项目最恨的：用户会以为存上了。
   *   ⑤ **底图一律从"那一版的干净位图"编码**（★ 2026-10-08 账本，spec §3）——
   *      老代码是从**画布**编码的，那是"刷新后参数应用两次"的根，见下面那段。
   */
  useEffect(() => {
    const last = history[history.length - 1]
    if (sessionId === null || !last) return
    // ★★ 2026-10-08（账本，Task 7，spec §7.2）：**哪一版脏了送哪一版**。
    //   `dirtyRef` 指名了一版（用户最后动过的那一版），这一趟的
    //   `params` / `lut` / `base` 说的都是**它的"现在"**，服务端按 `stateStepId`
    //   落在**那一版**上（§7.1）—— 于是"站在旧版本上拖的那一档"存得进旧版本。
    //   ⚠️ 旧的 `atTip`（"只有站在最后一步才送 params"）就此退役：它治的是
    //   "旧版本的参数被写进最新那一步"那个病，但那是**治症状**、而且只治一半 ——
    //   站在旧版本上的改动本来就该存进旧版本。`stateStepId` 才是那把对的刀。
    //   ⚠️ 没人脏（`null`）= 这一趟只说"对话和步骤长什么样"，状态一个字节不动。
    const dirtyAt = dirtyRef.current
    const dirtyVersion = dirtyAt ? history.find((s) => s.id === dirtyAt.stepId) : undefined
    // 那一版已经不在历史里了（被删掉 / 换了会话）→ 这一趟**不当它是脏的**：
    // `stateStepId` 指的必须**合并后存在**，否则服务端 400（那是新协议的信任
    // 边界，别拿一个死号去撞）。
    const stateStepId = dirtyAt && dirtyVersion ? dirtyVersion.id : undefined
    // 状态那两样**从快照上取**，不读闭包里的 `params` / `lut`：站在 A 版上改、
    // 跳走之后再落盘时，闭包里那两个永远是"人**现在**站的那一版"的 —— 送错了版本
    // 就是"刷新之后 B 的样子被写进 A 的账上"。写回那条 effect 一直在把现场镜像进
    // 快照，所以快照上那一份就是"改之后"。
    const stateParams = dirtyVersion?.params
    const stateLut = dirtyVersion?.lut
    // ★★ 底图从**位图**编码，**不是画布**（spec §3 那个 bug 的修法）。
    //   画布上跑过 `render(params)`：拿它当底图 = 把参数**烤进像素**，恢复时
    //   `setImage(base)` + `setParams(同一套参数)` 就把参数作用了两次（真机实测：
    //   画布平均亮度 100.73 → 120.88，对照组 0.00）。位图天然干净（铁律：**参数
    //   永远不烘焙进 base**），而且它**不依赖屏幕上有没有画布**。
    //   ⚠️ 只在 `baseChanged` 那一支里编码 —— 编码一张 2048 长边的 JPEG 不便宜，
    //   拖滑块那几十趟不该为它买单。
    const baseBitmap = dirtyAt?.baseChanged && dirtyVersion ? dirtyVersion.base.bitmap : null
    const snapshot = history.map((s) => ({
      id: s.id, label: s.label, params: s.params, prompt: s.prompt, at: 0,
      // ★ 2026-10-05（滤镜）：每一步各自的 `lut` 也按 `SessionStep` 的形状带上。
      //   ⚠️ **今天它是无效载荷**（2026-10-05 审查更正 —— 之前这里写的是反的）：
      //   服务端 `mergeSteps` 对**库里已有的 id** 是 `if (old) { out.push(old); continue }`
      //   —— 原样保留库里那条，payload 里这一步的 params / prompt / lut 一个字都
      //   不采纳；真正从 payload 构造的只有**新步骤**，而新步骤紧接着又被顶层
      //   `patch.lut`（`handleUpdateSession` 里、在 mergeSteps **之后**）盖成当前滤镜。
      //   留着它的理由：这是线上的**形状**（`SessionStep.lut` 是协议的一部分），
      //   哪天服务端改成"客户端赢"或这里多出"一次 PUT 带好几个新步骤"的走法，
      //   少这一个字段就会静默丢滤镜。**别因为"今天没人看"把它删掉。**
      lut: s.lut,
    }))
    // ⚠️ `ChatMessage` 上**没有 `at`**（这个客户端不显示消息时间），而
    //   `SessionMessage.at` 是必填的 —— 送 0 = "这个信息我们没有"（服务端
    //   `readMessages` 收到缺省时落的也是 0）。**不能在这里现取 `Date.now()`**：
    //   这一串每次落盘都整段重发，`Date.now()` 会把**每条**消息的时间每次改写成
    //   "此刻"，比没有更糟。将来真要在气泡上显示时间，该改的是 `ChatMessage`
    //   （加一个字段、在 `say`/`send` 那几处写进去），不是在这里补一个数。
    const messagesNow = messages.map((m) => ({ ...m, at: 0 }))
    // ★★ `params` / `lut` **留在依赖数组里**（最后那一行），但它们**不再进 payload**
    //   —— payload 的状态那半读的是快照（`stateParams` / `stateLut`）。
    //   为什么留着这两个依赖：这一趟落盘**必须跟着它们重跑**。今天"改了参数"还会
    //   顺带触发上面写回 effect 的那次 `setHistory`（`history` 也在依赖里），所以
    //   单看今天，删掉这两项**测不出来** —— 但那是"今天"、而且是靠另一条 effect
    //   顺带兜住的：它们是"**改了参数 / 滤镜 ⇒ 要重排一趟落盘**"这件事直说的那一半。
    //   2026-10-01 那次评审查出来"拖完滑块一次都不落盘、而屏幕上什么都不说"，
    //   病根就是依赖漏项。**别删。**
    // ★★ 画布**在这一刻**拿到手，不在发的时候现读（2026-10-01 终审 C1）。
    //
    //   为什么不能在 `run` 里现读 `canvasElRef.current`：画布只在「修图」那一屏
    //   存在（`{view.kind === 'edit' && …}` 一卸载，`Canvas` 那个回调 ref 就把它
    //   置回 null），而**切导航不会让这个 effect 重跑**（依赖里没有 `view`）——
    //   800ms 后闹钟响时用户可能已经在「对话」/「作品」上，现读就是 null。
    //   ★ 2026-10-08（Task 7）：它今天**只管封面**（`thumb`）—— 底图走位图那条路、
    //   与画布在不在无关。画布不在就跳过封面，**patch 照发**。
    //   （老代码在这儿 `return`：那一句把**整份 patch**（messages / steps / params /
    //   base / thumb）一声不吭地全扔掉 —— 用户花了钱生成的那一步永远到不了服务端，
    //   刷新回到生成之前，而且不是"请求失败了"，是**压根没发**。连 `flushPersist`
    //   也救不回来（它调的是同一个 `run`）。那条病根正是"底图非要从画布来"。）
    //
    //   为什么现在拿不会拿到陈的：这个 effect 每次 `history` / `params` 变化都会
    //   重跑，所以这一份记号永远是"最后一次改动那一刻那张画布"。
    //   而**画布卸载之后像素还在**（元素还被这个 ref 引用着，`drawImage` /
    //   `toDataURL` 照常工作）—— 这正是这个修法成立的原因。
    const el = canvasEl.current

    // ③：这里只**定一个闹钟**，不等任何网络。下一次改动会把这个闹钟重设。
    //
    // ★ 活儿抽成一个 `run`，并且**登记**到 `pendingPersistRef` 上：用户改完
    //   立刻切会话（左栏「对话」里点开一条 / 按「新的一张」）时，`loadSession`
    //   会在改状态之前把它**提前点掉**（`flushPersist`）—— 不登记的话这个闹钟
    //   连响的机会都没有：依赖（`sessionId` 就在里面）一变，下面那句清理就把
    //   它清掉了，上一条最后那几秒的改动永远丢了，且一句话不说。
    const run = (keepalive = false) => {
      const seq = ++persistSeqRef.current
      // ★ "这一趟要销的是**哪一笔账**" —— 在这儿（**发出去之前**）就定死。
      //   ⚠️ 别等请求回来再读 `dirtyRef.current`：请求在路上时用户完全可能又拖了一档
      //   （那是一笔**新的**待办）；回来时读到它、拿它去销，那一笔就**永远不会再送**
      //   —— 屏幕上那句"接着改会自动补上"当场变成假话。
      //   （老代码这里是 `baseSeqRef` 那个底图版本号，形状一样、道理一样：
      //    发之前定死，回来只销自己那一趟。）
      const sending = dirtyRef.current
      void (async () => {
        try {
          const patch: SessionPatch = { messages: messagesNow, steps: snapshot }
          // ★ 状态三件**同生共死**：服务端按 `stateStepId` 把 `params` / `lut` 写在
          //   **那一版**上，而"指名的步骤必须存在"是它的信任边界（§7.1）—— 三样
          //   缺一样都不该送。少了 `stateStepId` 那一样尤其致命：那是**静默退回**
          //   "写最后一步"的旧行为，站在旧版本上拖的那一下会被塞进最新那一步。
          //   ⚠️ 而"没人脏"这一趟（`stateStepId === undefined`）**根本不进这个分支**
          //   —— 服务端那边判据是 `!== undefined`，不带键 = 一个字节都不动。
          if (stateStepId !== undefined && stateParams !== undefined) {
            patch.stateStepId = stateStepId
            patch.params = stateParams
            patch.lut = stateLut ?? null
          }
          // ② 底图没换（拖滑块那几十趟）就**不许带** —— 带了就是多存一个没人引用的
          //   文件，而且服务端会把好好的缩略图删了重存（§4.3）。
          if (baseBitmap) {
            // ★ 走 `bitmapToDataUrl(baseBitmap, 0.9)`（编码前压到 `MAX_DIMENSION`），
            //   **不是** `el.toDataURL` —— 底图可能是张几千像素的原图/回图，而生成
            //   那条路上有个"**提供方回的图比它声明的更大**"的偏差分支（见上面
            //   "以实际为准，不拉伸"那一段）：4096² 的 JPEG 0.9 能顶到服务端 8MB
            //   那条线 → 413 → 「刚才那一步没存下来」**指错原因**，而且会反复发生。
            //   ⚠️ 压的**只是上路这一份**：那张位图本身**不许缩、也不许关** ——
            //   它还是画布上正在看的那一版（缩了 = 每次导出降级）。
            patch.base = bitmapToDataUrl(baseBitmap, 0.9)
            // ★ 缩略图**跟着 base 一起换**，spec §6.3 要求列表上是「最后那张」的样子。
            //   不换的话，列表永远显示刚上传那张原图 —— 用户改了半天，左栏「对话」里
            //   还是那张没改过的照片，而且**不报错**。
            //   只在 `baseBitmap` 那一支里做：图没变的时候重做一张是白费（而且会让
            //   服务端把好好的缩略图删了重存）。
            //   ⚠️ **封面照旧从画布抓**（它 = 现在**看到**的观感，正好和底图那条路
            //   相反 —— 底图要干净、封面要好看）；画布不在（切屏之后到点）就**只跳过
            //   封面这一样**，别的照发。
            if (el) {
              try {
                patch.thumb = makeThumbnail(el, GALLERY_THUMB_MAX_SIDE)
              } catch (e) {
                // 封面是锦上添花（就是列表上那张小图），抓不到不该影响这一版底图
                // —— 而且这**不是可选项**：异常路径正是没人盯着的那条，
                // 不许静默（这个项目每一处"没做成"都要留痕）。
                console.error('封面没做出来（不影响底图落盘）', e)
              }
            }
          }
          // ★ `keepalive` 只在"页面正在消失"那两条路上传进来（`pagehide` /
          //   切到后台，见下面那个 effect）。但**不能无条件用**：浏览器对 keepalive
          //   的请求体有 64 KiB 硬上限，超了 fetch 当场被拒 —— 那比普通 fetch 还差
          //   （普通 fetch 至少"可能发得完"，被拒是必然发不出）。所以量一下：
          //   ⚠️ 量的必须是**编码后的字节数**（`TextEncoder`），不是 `length` ——
          //   一屏中文一个字三个字节，数字符会少算三倍。
          //   （典型体量：说一句话 / 拖滑块 ≈ 几 KB，能带；带一整张底图 ≈ 一两 MB，
          //    必然超 —— "刚生成完就按 F5"那种场景这一版接受"可能赶不上"，
          //    边界写在设计文档 §7。）
          const keepaliveOk = keepalive
            && new TextEncoder().encode(JSON.stringify(patch)).byteLength <= KEEPALIVE_MAX_BYTES
          await updateSession(sessionId, patch, keepaliveOk)
          // ⑤：**写成功之后**才把这一笔账销掉（失败就留着，下一次改动再送一遍 ——
          //   屏幕上那句"接着改会自动补上"说的就是它）。销的是**这一趟送出去的那份
          //   待办**（`sending`，发之前定死的），不是"回来时的当前待办"。
          //
          // ★ 两个判据都要，各挡一种"销错账"：
          //   · `dirtyRef.current === sending`：这一趟在路上时用户又动了手（拖了滑块
          //     / 又裁了一刀）—— 那是**新的一笔待办**，不许被这趟连带销掉；
          //   · `sessionIdRef.current === sessionId`：**我回来时还是不是当时那条会话**。
          //     切走之后才回来的应答，`loadSession` 已经替新会话把记号对齐过了
          //     （它进门就清 `dirtyRef`）—— 这时候还按上一条那份去销，销掉的会是
          //     **新会话上那一笔**（用户在新会话里刚拖的那一下就这么没了，不报错）。
          //     ⚠️ 用 `sessionIdRef`（回来时的）不是 `sessionId`（发出去时的）——
          //     后者永远等于自己，这个判据就没了。切走那趟的 `flushPersist` 让这条
          //     时序从"几乎撞不上"变成常事（2026-10-01 评审抓到的）。
          if (dirtyRef.current === sending && sessionIdRef.current === sessionId) {
            dirtyRef.current = null
          }
        } catch (e) {
          // 只认**最新**那一次失败 —— 早先那几次可能已经被后一次覆盖掉了，
          // 那时候弹"没存下来"是在说一件已经不成立的事
          if (seq === persistSeqRef.current) {
            console.error('这一步没存下来', e)
            // ★ 2026-10-06（晚）：原来是「刚才那一步没存下来，刷新可能接不上。」
            //   —— 用户提的"不能模棱两可"：**"接不上"是什么、刷新会怎样、
            //   我现在该干嘛**，三个问题一个都没回答。现在两句都是能对着核的：
            //   · "没存进这条对话" = 说的是**哪儿**（一句"没存下来"像在说本地文件）；
            //   · "现在刷新会少这一步" = 后果（接不上是"少哪一步"，不是"连不上网"）；
            //   · "接着改会自动补上" = 出路，而且是**真的**：下一次落盘送的是
            //     整份 `messages` + `steps`（见上面 `patch` 那段），这一步跟着一起走。
            noticeBad('刚才那一步没存进这条对话。现在刷新会少这一步；接着改会自动补上。')
          }
        }
      })()
    }
    const timer = setTimeout(() => {
      // 到点了：先把待办摘掉再跑 —— 跑的当中 ref 里要是还留着这一条，
      // 一次"提前点掉"（flushPersist）就会把这趟发第二遍。
      if (pendingPersistRef.current?.timer === timer) pendingPersistRef.current = null
      run()
    }, 800)
    // ★ 登记"还没到点的那一趟"（见上面 `run` 那段）
    pendingPersistRef.current = { run, timer }
    return () => clearTimeout(timer)
    // ⚠️ `sessionId` **必须在依赖里** —— 它一到，这个副作用得再跑一遍，
    //   否则"上传之后立刻动的那一下"落不了盘（见 `sessionId` 那段长注释）。
    // ⚠️ `params` / `lut` 同一条（见上面那段"为什么留着它们"）；★ 2026-10-05 起
    //   `lut` 也在。
    // ⚠️ `cursorId` 也在依赖里：跳转之后这一趟得再跑一遍（而且 `onJump` 里那句
    //   `flushPersist` 只结掉**跳走之前**那份 payload，跳过来之后这一版的账
    //   还得有人看着）。
  }, [history, messages, params, lut, sessionId, cursorId])

  /**
   * 页面**要走了**（刷新 / 关标签页 / 切到后台）—— 把还没到点的那趟落盘立刻发出去。
   *
   * ★ 2026-10-01 终审 I1 加的。验收线第 1 条是「上传 → 说一句话 → **刷新** →
   *   照片、对话、参数全在」，而验收的人正是**看见结果就按 F5**：那一刻 800ms
   *   防抖还没到点，而那个闹钟是挂在 effect 里的 —— 页面一卸载就没了。那一句话
   *   **一个字节都没发出去**，而且连一条失败记录都没有（请求压根没发），
   *   用户回来看到的是"我说的话没了"，跟没存过一样。
   *
   * ⚠️ **两个事件都要挂，各管一半**（少一个就有一种"页面要走了"接不住）：
   *   · `pagehide` 管"页面真的要没了"：刷新、关标签页、导航走、手机上切 App；
   *   · `visibilitychange → hidden` 管"切标签页 / 切到后台"：移动端上标签页
   *     被系统冻结前多半只来这一个（`pagehide` 不一定来），而且桌面切标签页
   *     也是"用户以为放下了、回头可能再也不回来"的那一刻。
   * ⚠️ 两处都走 `keepalive`：普通 fetch 会在卸载时被浏览器掐断（见 `run` 里
   *   那段和 `./api/client` 的 `send`）。体量超了 64 KiB 的那种（带整张底图）
   *   会自动退回普通 fetch —— 边界写在设计文档 §7，不在代码里说了算。
   * ⚠️ **重复触发无害**：`flushPersist` 第一句就把待办摘掉了，第二次进来是空操作
   *   （两个事件在真机上本来就经常连着来）。
   */
  useEffect(() => {
    const bye = () => flushPersist(true)
    const onVis = () => { if (document.visibilityState === 'hidden') bye() }
    window.addEventListener('pagehide', bye)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', bye)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [flushPersist])

  return { flushEdit, flushPersist, pendingPersistRef }
}
