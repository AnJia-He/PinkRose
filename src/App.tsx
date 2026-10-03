import { useCallback, useEffect, useRef, useState } from 'react'
import { User } from 'lucide-react'
import { Btn } from './ui/kit/Btn.tsx'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import ChatPanel, { type ChatMessage } from './ui/ChatPanel'
import { LoginPage } from './ui/LoginPage'
import { GalleryPage } from './ui/GalleryPage'
import { SessionsPage } from './ui/SessionsPage'
import { WorkDetailPage } from './ui/WorkDetailPage'
import { AccountPage } from './ui/AccountPage'
import { ModelSettings } from './ui/ModelSettings'
import LandingPage from './ui/LandingPage'
import { Nav } from './ui/Nav'
import logoMark from './assets/logo/rose.svg'
import { FRONT_PAGE, askedForFrontPage, pathOf, viewFromPath, type View } from './ui/view'
import { me, type AccountUser } from './api/account'
import {
  createSession, getSession, listSessions, sessionOriginalUrl, sessionStepUrl,
  updateSession, type SessionPatch,
} from './api/sessions'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { resizeBitmap } from './image/resize'
import { samplePixels } from './image/sample'
import { matchToReference } from './core/colorMatch'
import { fitToLimit, probeLimit } from './render/limits'
import { applyDeltas, ZERO, type Adjustments } from '../shared/adjustments.ts'
import { canShareImage, downloadImage } from './export/save'
import { prepareForRouting } from './image/prepare'
import { ApiError, isUnauthorized, postRoute } from './api/client'
import { bitmapsToClose, attachThumb, jumpTo, type Snapshot } from './core/history'
import { GALLERY_THUMB_MAX_SIDE, THUMB_MAX_SIDE, bitmapToDataUrl, makeThumbnail } from './core/thumbnail'
import { markImage, type NormPoint } from './image/mark'
import { useDelivery } from './app/useDelivery'
import { useGeneration } from './app/useGeneration'
import type { SuggestCard } from '../shared/protocol.ts'

/**
 * 建议卡片最多等这么久。**它只决定那个"正在看…"的提示挂多久，不再拦人。**
 *
 * `/api/suggest` 最坏会占住后端串行队列约 4 分钟（上游挂掉时队列重试 4 次、
 * 每次超时上限 60 秒）。跨任务裁定：**不在后端特例化**（那会削弱队列统一的
 * 重试契约），改由前端不阻塞。
 *
 * ⚠️ 2026-09-30 改了这条的用法。原来这里是 `Promise.race` 的一道超时闸：
 * 10 秒一到才把用户"放出来"，之前发送键是 **disabled** 的、屏幕上写着
 * 「正在看你的照片…」。而实测卡片要 11~15 秒才回来 —— 也就是说，**30 秒
 * 预算里有整整 10 秒是纯干等**（用户上传完到能开口之间什么都做不了），
 * 而卡片本来只是个可选件、晚到就晚到。现在改成：用户**立刻**能说话，
 * 那个提示自己在那儿转，卡片回来了就换成卡片，超时就把提示收掉。
 */
const SUGGEST_WAIT_MS = 10_000

/** 「按住看原图」那张预览的边长上限。
 *  不直接拿原图：3000 万像素重新上传一次纹理很贵，而"看原图"永远是在
 *  屏幕大小上比的，1280 已经看不出和原图的差别。 */
const ORIGINAL_PREVIEW_MAX_SIDE = 1280

/**
 * 落盘那趟在"页面正在消失"时敢不敢用 `keepalive` 的**体量上限**（字节）。
 *
 * 浏览器对 keepalive 的请求体有 **64 KiB 的硬上限**，超了 fetch 会被**当场拒绝**
 * —— 那比普通 fetch 还差（普通 fetch 至少"可能发得完"，被拒是必然发不出）。
 * 所以调用点先量一下，超了就退回普通 fetch（见落盘 effect 里那段）。
 * 取 60000 而不是 65536：给 JSON 头尾和将来加的字段留一点，别卡在边界上。
 *
 * ⚠️ 两种体量分得很开，这个数取中间哪都行：说一句话 / 拖滑块 ≈ 几 KB；
 * 带一整张底图（base64）≈ 一两 MB，必然超。
 */
const KEEPALIVE_MAX_BYTES = 60_000

/**
 * 照片超出本设备能画的上限时，先缩到画得动，再照常修。
 *
 * 2026-09-23 加。起因是真机实测：手机拍的 4928×6560（32.3 MP）撞上一台
 * 只报单边 4096 的手机 —— 而手机拍出来的照片本来就常常这么大。原来的行为是
 * 拒绝渲染并说清原因，**诚实但用户什么都拿不到**，真实用户到这一步就关页面了，
 * 「30 秒发朋友圈」那条成功线根本不成立。
 *
 * 这不是把「调色不缩图」那条铁律作废，而是给它补上前提：那条铁律的本意是
 * **不许偷偷缩**（悄悄缩 = 骗人），不是**永远不缩**。这里缩了会明说，
 * 用户手机里的原图一个字节都没动。触发条件也窄——只在设备真的画不动时才走。
 *
 * 返回要说给用户的那句话（没缩就是 null，由调用方决定去哪说）。
 */
async function fitToDevice(
  img: DecodedImage,
): Promise<{ image: DecodedImage; note: string | null }> {
  // 问不到上限 = 这浏览器根本没有 WebGL2。真正的原因由渲染那一步的提示去报，
  // 那句比这里准（见 ui/Canvas.tsx 的 fail）。在这里凭空猜一个上限去缩是错的：
  // 换浏览器就能解决的事，不该拿画质去换。
  const limit = probeLimit()
  if (!limit) return { image: img, note: null }

  const fit = fitToLimit(img.width, img.height, limit)
  // 画得动就一个像素都不动。缩一次是永久的画质损失，绝大多数照片不需要。
  if (fit.width === img.width && fit.height === img.height) return { image: img, note: null }

  const bitmap = await resizeBitmap(img.bitmap, fit.width, fit.height)
  // 旧的那张不会再有谁用（新的那张才是接下去的一切），立刻还回去。
  // 32 MP 一张约 129 MB 的 GPU 内存，漏在这儿比别处都贵。
  img.bitmap.close()

  // 尺寸以**新位图自报的**为准。和生成那一路同一个道理：声明可能与实物不符，
  // 拿声明去设画布会把照片拉变形。
  return {
    image: { bitmap, width: bitmap.width, height: bitmap.height },
    note: `这张照片 ${img.width}×${img.height} 太大了，浏览器画不动。` +
      `我按 ${bitmap.width}×${bitmap.height} 来修 —— 调色照常，` +
      `只是导出的图会比原图小一点。`,
  }
}

/**
 * 正在等用户在图上点一下（spec §6.3 的歧义兜底）。null = 没在等。
 * 刻意做成**一个**对象而不是三个平行 state：这两轮审查连续抓到的两条钱类漏洞
 * （onCard、onJump 各漏清一行）根因都是这个形状 —— 三个 state 散在七个写入点上，
 * "清干净"全靠人记得清三行。折成一个对象之后，这类漏项从"要记得清"变成
 * **结构上清不掉**：一处 `setPending(null)` 就是全清。
 *
 * - `text`：卡住时用户的原话 —— 确认之后要**连同标记一起**再送一次，不能让他重说。
 * - `marker`：用户在图上点的那个点（0~1，相对照片左上角）。null = 还没点。
 *   对象还在 = **整条点选流程还在**：从"请你点一下"开始，到确认或取消为止。
 *   点过一次也还在（marker 非空），否则用户点歪了就没法换个地方再点 ——
 *   见 onPickPoint。
 */
type PendingMark = { text: string; marker: NormPoint | null }

export default function App() {
  /** 当前登录的人。null = 没登录（或者还在问后端）。 */
  const [user, setUser] = useState<AccountUser | null>(null)
  /** 开机那一次"我是谁"问完了没有。
   *  它和 `user` 是**两件事**：`user === null` 既可能是"没登录"、也可能是
   *  "还没问出来"，不分开的话每个还没登录的人都会先看到登录页闪一下。 */
  const [checking, setChecking] = useState(true)

  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  const [showPanel, setShowPanel] = useState(false)
  /** 非 null 时既是"正在忙"的标志，也是要显示给用户的那句话 */
  const [busy, setBusy] = useState<string | null>(null)
  /** 本设备能不能把图交给系统分享面板。只在挂载时算一次：设备能力不会中途变。
   *  用惰性初始化（传函数），免得每次 render 都去 new 一个探针 File。 */
  const [canShare] = useState(canShareImage)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cards, setCards] = useState<SuggestCard[]>([])
  /** 正在等建议卡片。**它不拦任何人** —— 发送键照常能按、话照常能说，
   *  它只负责在卡片那一格上挂一句"正在看这张照片能改什么…"。
   *  （`busy` 是"现在什么都做不了"，这个不是。两件事，别合并。） */
  const [suggesting, setSuggesting] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  /** 「按住看原图」用的预览图（data URL）。没照片时是 null。 */
  const [originalPreview, setOriginalPreview] = useState<string | null>(null)
  /** 图上点选那一整条流程的状态（见 PendingMark）。null = 没在等用户点。 */
  const [pending, setPending] = useState<PendingMark | null>(null)

  // 下面三样**从 `pending` 推出来**，不再各自是一个 state —— 推出来的东西不可能
  // 互相不同步，这正是折成一个对象的意义。名字保留，读代码时不必重新认路。
  const picking = pending !== null
  const marker = pending?.marker ?? null
  const pendingText = pending?.text ?? null

  /** 这一趟修图（同一张上传的照片）里，上一次存进去的是哪个。
   *  **换图时清零** —— 它记的是"这张照片"，换一张就该重新问（§3.4）。 */
  const [savedId, setSavedId] = useState<number | null>(null)

  /**
   * 这一趟修图挂在服务端哪条会话上。null = 还没建起来（正在建、或者建失败了）。
   *
   * ⚠️⚠️ **必须是 state，不能是 ref。** 这一条是 2026-10-01 实测出来的坑：
   *   建会话是**不 await** 的（见 `onPick`），所以上传之后有一段时间 `sessionId`
   *   还是 null。而那个落盘副作用的第一句就是"没有会话就 return"。
   *
   *   用 ref 的话：用户上传完**立刻拖一下滑块**（那是这个产品最自然的第一个动作 ——
   *   落地页写的就是"拖滑块不用登录"），副作用跑起来看到 null，**直接 return**；
   *   等建会话终于回来、把 id 写进 ref，**ref 的变化不触发重渲染**，于是副作用
   *   再也不会为那一次改动跑一遍 —— **那一版改动永远不会落盘，而且不报错。**
   *   等用户刷新才发现，而那时候他已经说不清丢了什么了。
   *
   *   换成 state 之后，id 一到就重渲染、副作用自己再跑一遍 —— 竞态没了，
   *   而且比 ref 少一个概念（一个真值来源，不是两个）。
   */
  const [sessionId, setSessionId] = useState<number | null>(null)
  /**
   * `sessionId` 的**影子**（ref 版）。它存在的理由只有一个：落盘那一趟是
   * **异步**的，它回来时要问"我**现在**还是不是当时那条会话"。state 在异步
   * 闭包里读到的是**发出去时**的值（永远是"是"），而这件事要的是"**回来时**"
   * 的答案（2026-10-01 评审抓到的：切会话之后上一条的应答才回来，会把
   * `lastPersistedBaseSeqRef` 拨回去 —— 见落盘里那一行）。
   *
   * ⚠️ 它**不是** state 的替代：上面那段说的"必须是 state"照旧成立。它只是
   *   一个只读给异步代码看的影子。
   */
  const sessionIdRef = useRef<number | null>(null)
  /**
   * 切会话**唯一**该走的那道门：state 和影子**在同一个函数里**一起改。
   *
   * ⚠️ 别改成 `useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])`
   *   去追 —— "渲染过了、effect 还没跑"那个窗口里影子还是旧值，而落盘的应答
   *   完全可能落在这个窗口里，那正是这个影子要堵的洞。
   */
  const setCurrentSession = useCallback((id: number | null) => {
    sessionIdRef.current = id
    setSessionId(id)
  }, [])
  /** 顶上那条**通报**：有件事要跟你说一声，说完可以收走（2026-09-30）。
   *
   *  它取代了原来三处 `window.alert`。系统弹窗有两个毛病：它把整页冻住，
   *  而且长得**不像这个产品的一部分** —— 一个花了一整天做视觉的产品，
   *  出错时突然跳出一个灰扑扑的系统框，那一下就把"做完了"的感觉打回去了。
   *
   *  `tone` 只有两种：`bad`（这件事没成，留着等用户看完自己点掉 ——
   *  他可能要去别处看一眼再决定怎么办）和 `ok`（成了，几秒后自己走）。
   *
   *  ★ **「存好了」也走这里，不是因为它是个错误**：手机上打开调色面板时
   *  **对话栏整个是隐藏的**（面板和对话在抢竖向空间，见 styles.css 那条 `:has`），
   *  而那一刻正是用户拖完滑块、按「保存」的时候 —— 那句话会落进
   *  **一个用户看不见的地方**。（2026-09-30 全链路回归在手机那趟抓到的：
   *  桌面那一趟全绿，只有"打开面板再保存"这一串下来屏上什么都没有。）
   *
   *  ⚠️ 它和 `saveFail` 是**两种东西，别合并**：那条横幅是"图还在，先拿到手"，
   *  自带一个下载按钮，而且**不许被关掉**（关掉用户就真的拿不到那张图了）；
   *  这条只是通报，「知道了」就该收走。 */
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null)
  /** 通报一句"没成"。**身份必须是稳定的** —— 它直接传给 Canvas 的 `onFail`，
   *  而那边进了 effect 的依赖数组（理由见 Canvas.tsx 那段）。 */
  const noticeBad = useCallback((text: string) => setNotice({ text, tone: 'bad' }), [])
  /** 通报一句"成了"。和 `noticeBad` 一样，身份必须稳定（两者都会进
   *  `useDelivery` 的依赖数组）。 */
  const noticeOk = useCallback((text: string) => setNotice({ text, tone: 'ok' }), [])

  // "成了"的通报自己会走：它是**回执**，不是待办。
  // 用函数式更新加一道守卫 —— 这几秒里用户可能已经触发了别的通报，
  // 无条件 `setNotice(null)` 会把**新的那条**一起抹掉。
  useEffect(() => {
    if (notice?.tone !== 'ok') return
    const t = setTimeout(() => setNotice(n => (n?.tone === 'ok' ? null : n)), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)

  const originalFileRef = useRef<File | null>(null)

  /**
   * 「把成品交到用户手上」那一整件：导出 / 分享 / 下载到电脑 / 存进作品集，
   * 以及"上次那张要替换掉吗"。
   *
   * 2026-10-02 从**这个文件里整段搬出去**的（原文照搬，注释一条没丢）——
   * 它在这边原本是两百多行挤在一个两千行的组件里，而它跟"修图"本身没关系：
   * **图已经改好了，那一段只管怎么交出去**。见 `src/app/useDelivery.ts`。
   */
  const {
    delivering, asking, saveFail, onShare, onDownload, onSave, answerAsk,
    dismissAsk, setSaveFail,
  } = useDelivery({
      canvasEl: canvasElRef,
      originalFile: originalFileRef,
      savedId, setSavedId, params, messages, noticeBad, noticeOk,
    })
  const idRef = useRef(0)
  /** 每次选图 +1。只做一件事：**认出"这句提示还该不该挂"** ——
   *  它和 `myPick` 配对，用来收掉那句"正在看这张照片能改什么…"
   *  （见 onPick 里的 `settle`）。卡片**算不算数**看的是 `baseSeqRef`，
   *  不是它 —— 两件事，别合并（理由写在 loadCards 那段）。 */
  const pickIdRef = useRef(0)
  /** **底图**换过几版。上传 +1、每一次生成式编辑 +1。
   *  它是"卡片是不是还算数"的那道闸门（见 loadCards）——
   *  「回到这一步」换底图**故意不算**（它换回的是同一张照片的旧版本，
   *  卡片说的仍然成立，而且跳回原图之后那批卡片恰好又是对的）。 */
  const baseSeqRef = useRef(0)
  /** 落盘的次序号。后一次回来时前一次可能还在路上 —— 只认最新的那一次 */
  const persistSeqRef = useRef(0)
  /** 上一次**成功写进服务端**的底图是第几版。只在写成功之后才更新 —— 见下面那句注释 */
  const lastPersistedBaseSeqRef = useRef(-1)
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
  /** 挂载时那次"把上次那条会话接回来"跑过没有。**它保证只跑一次** ——
   *  为什么不能跟着 `user` 每次变都重跑，见下面那个恢复 effect 的注释。 */
  const restoreTriedRef = useRef(false)
  /**
   * 用户**这次打开页面之后自己动手传过照片**了没有。`onPick` 一进门就置位
   * （**在任何 await 之前**），此后一直是 true（换照片 = 重开一次，没有"取消选图"）。
   *
   * ⚠️ 为什么非要这么一个 ref、而不是只看 `baseSeqRef`：`onPick` 进门后有两趟
   *   await（`decodeImageFile`、`fitToDevice`），而 `baseSeqRef` 要等解码完才
   *   `++` —— 那几十到几百毫秒里，只看 `baseSeqRef` 会以为"用户还没动手"。
   *   恢复那串网络往返正好落在那个窗口里的话，它会把旧会话照常写上去，然后被
   *   `onPick` 的写入覆盖 —— **唯独那句通报没人覆盖**：用户盯着自己刚传的照片，
   *   屏幕上却写着「这是上次没做完的那张」。那正是 §6.2 要防的那种错，方向相反。
   *   （顺带：恢复吐出来的位图也就没人关了，`onPick` 里那次释放看的是**旧的**
   *   `history`。）
   */
  const pickStartedRef = useRef(false)
  /**
   * 用户**选照片**的次序号，`onPick` 进门第一句 +1（和上面那个布尔同一个位置）。
   * 配套的 `pickSettledSeqRef` 在这一趟**选完**时跟上（`onPick` 的 finally）——
   * "开始了几趟"减"选完了几趟"就是**现在有没有一张还在开**。
   *
   * ⚠️ 为什么除布尔还要序号：切会话那趟（`loadSession(id, 'open')`）的"作废"
   *   判据是**相对**的（这趟期间用户动了手才算数），而那个布尔**单调** ——
   *   用户早就选过照片的话，他在这趟里**再选一张**时布尔一动不动；同一段窗口里
   *   `baseSeqRef` 也还没动（它要等解码完才 `++`）。两道判据都看不出来，这趟就会
   *   照常写上去，把用户**刚选的那张**顶掉（屏幕上换成另一张照片，而且不报错）。
   *   序号每一趟都变，看得见。
   *
   * ⚠️ **今天这一条窗口走不到**（2026-10-01 评审后核的）：切会话那趟一进门就
   *   `setBusy('正在打开这条对话…')`，而 `busy` 非空时那一屏渲染的是那句提示、
   *   **上传器整个不挂**（`{busy ? <div className="hint">{busy}</div> : <Uploader/>}`）
   *   —— 用户没有入口在这趟里再选一张。留着是保险：哪天上传器在那期间一直挂着
   *   （比如加一个「换一张」），它当场算数。今天真正挡得住的是下面那个"还在飞"。
   */
  const pickSeqRef = useRef(0)
  /**
   * **选完**的趟数（`onPick` 的 finally 里 +1）。`pickSeqRef > 它` = 有一张照片
   * 还在开（`decodeImageFile` / `fitToDevice` 那几十到几百毫秒）。
   *
   * ⚠️ 切会话那趟要认这个：用户在等自己那张照片时点了另一条会话 —— 那一刻
   *   `baseSeqRef` 还没动（它要等解码完），只看版本号看不出"他手上正有一张在开"，
   *   于是那趟会照常写上去（把会话的照片、对话、步骤全铺上），过一会儿再被
   *   `onPick` 覆盖回来。今天这条路**真的走得通**：上传器在"正在打开照片…"期间
   *   是被 `busy` 藏起来的，但**切会话那趟之前**的那一瞬间照片就已经在飞了 ——
   *   用户完全可以在这时候回左栏去点一条对话。
   * ⚠️ 不能拿 `pickStartedRef` 顶替：它单调（第一次选过之后永远是 true），而
   *   "上回那张已经开好了"之后用户照样该能点开别的会话（App.test.tsx 的 ★★
   *   那条正是这么走的）。要的是"**现在**有没有在飞"，不是"曾经选过没有"。
   */
  const pickSettledSeqRef = useRef(0)
  /** 用户**这一趟说过的原话**（send / 卡片各写各的）。
   *  模型说拿不准时要把它留到用户点完图 —— 届时"原来那句话"是**那一刻**的那句，
   *  不是某个 state 里可能已经翻篇的那句。 */
  const pendingRef = useRef<string | null>(null)

  /**
   * 打开页面先问一句"我是谁"。没登录就显示登录页。
   *
   * 问的是后端而不是读 localStorage 之类的本地记号：**只有后端拿得出真身**
   * （id、email，而且"改密码把别的设备踢掉"这类事也发生在那一边 —— 票被作废了，
   * 本地那份记号却还留着，用户会以为自己登着）。`me()` 失败也返回 null，
   * 于是最坏情况退回登录页，不会把整个应用卡在"正在打开…"上。
   */
  useEffect(() => {
    me().then(u => { setUser(u); setChecking(false) })
  }, [])

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
   *   ① `idRef` 跳过接回来的所有 id（下面标了 ★★）；② `lastPersistedBaseSeqRef`
   *   跟着走；③ `pickStartedRef` 那道闸门；④ 作废时 `releaseDecoded()` 把位图还回去。
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
    if (why === 'open') flushPersist()
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

    try {
      const detail = await getSession(id)
      if (stale()) return discard('这条会话没接回来（作废了）：不是页面换了，就是用户自己动手了')
      // 一步都没有 = 这条会话是个空壳（正常到不了这儿：建会话时原图就算一步）。
      // 与其摆一张没有对话、「回到这一步」也点不动的空图，不如照旧让用户自己选。
      // ⚠️ 原来这里是**一声不吭地 return** —— 点了列表却什么都没发生，正是这个
      //   项目最恨的那种失败。留个痕。
      if (detail.steps.length === 0) return discard('这条会话一步都没有，不接（建会话时原图就该算一步）')

      /**
       * 恢复时**现做**这一步的小图（spec §5 明说服务端不存每一步的缩略图：
       * 「客户端本来就会给每一步生成缩略图，恢复的时候现生成就行」）。
       *
       * ⚠️ 不做的话**同一条对话刷新前后长得不一样**：活着的时候每一条助手气泡下面
       *   都挂着小图（`ChatPanel` 的 `thumbs[m.id] &&`），恢复出来只有最后一步有
       *   —— 而且**不报错**，`''` 只是"不渲染"。
       * ⚠️ 它是**锦上添花**那一类（和 `onPick` 里 `setOriginalPreview` 同一个道理）：
       *   做不出来只是这一步的气泡上没有小图，**绝不能让整条会话接不回来**
       *   （那会把可选项升级成必须项）。失败走 console.error，不许静默。
       */
      const thumbOf = (b: ImageBitmap): string => {
        try { return makeThumbnail(b, THUMB_MAX_SIDE) }
        catch (e) {
          console.error('恢复时缩略图没做出来（这一步的气泡上没有小图）', e)
          return ''
        }
      }
      // 每一步都要解码回位图。⚠️ `reusesPrev` 是真的能省一次下载 + 一次解码：
      // 拖十次滑块就是十步，一步步全下就是十个一模一样的文件。
      for (const s of detail.steps) {
        const prev = steps.at(-1)
        if (s.reusesPrev && prev) {
          // 和上一步是**同一张图**，小图直接接着用（重做一遍只会得到像素级不同、
          // 肉眼一样的两张 —— 而这正是"刷新前后长得不一样"里最没必要的一种）。
          steps.push({ id: s.id, label: s.label, base: prev.base, params: s.params,
                       isOriginal: false, thumb: prev.thumb, prompt: s.prompt })
          continue
        }
        const blob = await (await fetch(sessionStepUrl(detail.id, s.id))).blob()
        const bitmap = await createImageBitmap(blob)
        if (stale()) { bitmap.close(); return discard('恢复：这次接回来的已经不作数了（页面换了，或者用户自己动手了）') }
        steps.push({ id: s.id, label: s.label, params: s.params,
                     base: { bitmap, width: bitmap.width, height: bitmap.height },
                     isOriginal: steps.length === 0, thumb: thumbOf(bitmap), prompt: s.prompt })
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
      //   的是"导出能成，但没 EXIF、名字还叫 `_ruixing.jpg`" —— 比"没反应"更坏，
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
        // 空名字会让 `buildFilename` 产出 `_ruixing.jpg` 这种没法看的文件名。
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
      setHistory(prev => {
        // 切走的这条会话的位图要还回去（含它的原图）。不还就是"切几次把标签页拖垮"
        // —— 每张原图按 32 MP 算是 129 MB 的 GPU 内存。
        // ⚠️ 用 updater 里那个 `prev`，不用外面那个 `history`：这里要的是**真正被
        //   换掉的那一份**，而且 updater 里的写法不依赖闭包抓到的是哪一轮的 history。
        //    （`close()` 幂等，StrictMode 重放这个 updater 也安全。）
        for (const s of bitmapsToClose(prev, [])) s.bitmap.close()
        return steps
      })
      setImage(lastStep.base)
      setParams(lastStep.params)
      setMessages(detail.messages)
      // ★ 走 `setCurrentSession` 那道门（影子和 state 一起改，见它的注释）——
      // 这行在 'open' 那趟里改的正是"现在人站在哪条会话上"，而落盘的应答
      // 回来时要拿那个影子比对。
      setCurrentSession(detail.id)
      // 上一条照片那些**临时**状态跟着一起清（和 `onPick` 里换图时清的是同一批，
      // 同一个道理）：点选流程、"替换上次那张"的问句。不清的话，红圈会钉在
      // **另一张照片**上，而「就改这里」会拿旧标记 + 旧那句话花掉一次生成的钱。
      setPending(null)
      setSavedId(null)
      dismissAsk()
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
      // ★ 底图**换过一版了**（从 A 的换成 B 的）—— 记号往前挪一格，顺手把
      //   "这一版已经存过了"也记上：刚接回来的这一版**就是服务端上那一版**，
      //   别一进来就把它重传一次（不记的话：下一次落盘会带着 `base` 上路，而服务端
      //   每收一次 `base` 就存成一个新文件 —— 每条会话白白多背一张没人引用的
      //   全尺寸图，还白传一趟）。
      //   ⚠️ 这个 `++` 还顺手管住两件"迟到的活儿"：上传时那批**建议卡片**和
      //      十几秒前那次**生成**。它们回来时发现底图版本变了，就会自己作废 ——
      //      不作废的话，A 的卡片 / A 生成的那张图会**落进 B**（`loadCards` 那道闸门
      //      看的正是这个版本号）。
      baseSeqRef.current++
      lastPersistedBaseSeqRef.current = baseSeqRef.current
      // ⚠️ 两条通报**只有一格**（`notice` 是一个对象）：上面 catch 里那句
      //   "原图没取回来"先设、这里再无条件设一句，同一个批次里**后设的赢** ——
      //   用户只会看到"接着改就行"，而那一刻「保存」「分享」「下载」其实是坏的。
      //   所以两条合成一句：坏的那半留着（它带着动作），"上次那张"那半也不能丢
      //   （§6.2 要的那句话，这时候更不能省 —— 正是它告诉用户照片不是刚传的）。
      // ⚠️ 三颗按钮都要点名，不能只说「保存」「下载」：能分享的设备上，用户看到的
      //   那颗叫「分享」，漏了它就是"说的是屏幕上没有的那颗按钮"。
      // ⚠️ 点开那一路**不说"上次"那句**（理由见函数头 ③），但坏消息照说 ——
      //   它是真的，而且带着动作。
      const bad = '原图没取回来，「保存」「分享」「下载」可能用不了，刷新一下试试。'
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
      if (why === 'open') setBusy(null)
    }
  }, [flushPersist, noticeBad, setCurrentSession])

  /**
   * 打开页面之后，把"上次那条会话"接回来（spec §6.2）。
   *
   * ⚠️ 必须排在上面 `me()` 那一次之后 —— 要登录态。摆在前面的两句是同一个道理：
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

  /**
   * 「这句话该怎么改」到「花钱改一版」那一整件 —— 助手开口、路由决策、
   * 生成式编辑、停止、建议卡片。
   *
   * 2026-10-03 从**这个文件里整段搬出去**的（原文照搬，注释一条没丢），
   * 见 `src/app/useGeneration.ts`。搬走的是连续的一百多行，而它们说的是
   * 同一件事：**一轮对话怎么变成一次真实的改动**。
   *
   * ⚠️ 搬的时候依赖数组一个都没改 —— 那几条是踩过坑才长成那样的
   * （尤其 `applyDecision` 里"漏了 `image` 就永远捕获第一次 render 的 image，
   * 而且是静默的"那一条）。传进去的 `baseSeqRef` / `pendingRef` / `idRef`
   * 都是 ref（身份稳定），所以原来写 `[]` 的那几条依旧写 `[]`。
   */
  const { say, runGenerate, stopGeneration, applyDecision, loadCards, nextId } =
    useGeneration({
      image, setImage, params, setParams,
      baseSeqRef, idRef, setBusy, setUser, noticeBad,
      setCards, setPending, pendingRef, setMessages, setHistory,
    })


  const onPick = useCallback(async (file: File) => {
    // ★ **进门第一件事**，在下面两趟 await 之前：从这一刻起"用户自己动手了"。
    //   恢复那道闸门看的就是它（`baseSeqRef` 要等解码完才动，等它太晚 ——
    //   理由写在 `pickStartedRef` 的注释里）。这行必须在第一句 `await` 上面。
    //   ⚠️ 序号和布尔**在这儿一起动**，而这趟**结束**时（下面那个 finally）
    //   `pickSettledSeqRef` 要跟上：切会话那趟的判据既看"这趟里又选了一张"
    //   （序号），也看"**现在**有一张还在飞"（序号 > 已选完的趟数）——
    //   两头的账都记在这儿和那儿，漏一头就等于没记。
    pickStartedRef.current = true
    pickSeqRef.current++
    setBusy('正在打开照片…')
    try {
      const decoded = await decodeImageFile(file)
      // 超出本设备画布上限就先缩到画得动（并带回一句要跟用户说的话）。
      // 放在这儿、放在"进 history 之前"：缩完的那张才是这一趟的底，
      // 之后所有事（渲染、送模型、快照）看到的都该是同一个尺寸。
      const { image: img, note } = await fitToDevice(decoded)

      // 先释放上一张：ImageBitmap 占的是 GPU 内存，不关会一直攒着。
      // 要关的是**整份旧 history**——除了原图，还有每条生成式快照的 base
      // （2048 长边，最多 6 条）。只关原图会漏掉它们，换几次图就能把标签页拖垮。
      // 副作用留在状态更新外面，别塞进 updater（updater 可能被重放）。
      for (const s of bitmapsToClose(history, [])) s.bitmap.close()

      originalFileRef.current = file
      setImage(img)
      try {
        // 备用一张原图预览（spec §2.5 的"按住看原图"）。用刚解码出来的位图，
        // 不是画布 —— 这时候画布上还什么都没有。
        setOriginalPreview(makeThumbnail(img.bitmap, ORIGINAL_PREVIEW_MAX_SIDE))
      } catch (e) {
        // 预览和缩略图是同一类东西：**锦上添花**，抓不到只是没有「按住看原图」，
        // 修图照常。绝不能让它抛出去 —— 外面那个 catch 会说"这张图打不开"，
        // 而照片其实已经在画布上了；更要命的是下面那些欢迎语和历史一步都不会建，
        // 用户拿到的是一张没有对话入口的照片，整个应用不可用。
        console.error('原图预览生成失败（只是没有「按住看原图」，不影响修图）', e)
      }
      setParams(ZERO)
      setMessages([])
      setCards([])
      // 点选那套状态跟对话是同一趟的东西：换张照片就该一起归零，
      // 否则上一张照片的红圈和"原来那句话"会跟到新照片上。
      setPending(null)
      // 「上次那张要替换掉吗」记的是**这张照片**那一趟 —— 换了一张，
      // 那个"上次那张"就不存在了，再问就是拿别人的图问（§3.4）。
      setSavedId(null)

      // 原图自己也算一步，挂在欢迎语那条消息上 —— 这样「回到这一步」
      // 能回到最开始，撤销第一次生成时特别有用。
      const welcomeId = say('准备好啦，说说想怎么改？')
      // 缩过就得说。紧跟欢迎语，用户往下看第一眼就撞上，不会滑过去。
      if (note) say(note)
      setHistory([
        { id: welcomeId, label: '原图', base: img, params: ZERO, isOriginal: true, thumb: '' },
      ])

      // 卡片是**可选件，绝不能让用户等它**：这里只把它挂到后台去跑，
      // 发送键立刻就是可用的（见 SUGGEST_WAIT_MS 那段）。
      // ⚠️ **不 await**：await 了就等于又把用户挡回门外了，只是这次挡在
      //    另一行代码上。超时那条只负责收掉"正在看…"那句提示。
      const myPick = ++pickIdRef.current
      baseSeqRef.current++
      setSuggesting(true)
      const settle = () => { if (pickIdRef.current === myPick) setSuggesting(false) }
      const timer = setTimeout(settle, SUGGEST_WAIT_MS)
      // `void`：loadCards 自己吞掉所有错（它绝不 reject），这里也不等它。
      void loadCards(img).finally(() => { clearTimeout(timer); settle() })

      // ★ 在服务端把这条会话立起来。**不 await** —— 建会话是"锦上添花"，
      //   等它等于把用户挡在门外（上传那一步已经有一句"正在打开照片…"了）。
      //   建失败也**不影响本地修图**，但要说一声（见下面 catch）。
      //
      // ⚠️ 摆在这儿（`baseSeqRef.current++` **之后**）是有意的，不是随手挪的：
      //   建会话送上去的那张图 == 此刻这一版底图，下面要照着这个版本号记
      //   `lastPersistedBaseSeqRef`（否则第一趟落盘会重传一遍全尺寸底图）。
      //   摆在 `++` 前面的话捕到的是**上一版**，记进去等于没记。
      //
      // ⚠️ `setCurrentSession(null)` 这一行是**给同一趟里再换一张照片**留的保险：
      //   上一张的 id 还留着的话，落盘副作用会把**这一张**的步骤和消息写进
      //   **上一条会话**里 —— 串会话，而且不报错。（今天应用里没有"换一张"的
      //   入口 —— 换图 = 重开一次，所以这一行到不了；一行保险，留着。）
      setCurrentSession(null)
      void (async () => {
        try {
          // ⚠️ **在 await 之前**捕这一版底图：服务端手里那份 `base` 就是它
          //   （建会话送的就是这一版）。**不能**等 `createSession` 回来再读
          //   `baseSeqRef.current` —— 等的那会儿用户要是做了一次生成式编辑，
          //   `baseSeqRef` 已经往前走了，读"现在"的值会把这个记号设成新版本：
          //   服务端手里还是旧图，而那次编辑的底图会被**静默吞掉**（比多传
          //   一版坏得多）。
          const baseSeqAtCreate = baseSeqRef.current
          // `makeThumbnail` 是**同步**的（返回 data URL 字符串），别手滑写 await。
          const thumb = makeThumbnail(img.bitmap, GALLERY_THUMB_MAX_SIDE)
          const { id } = await createSession(bitmapToDataUrl(img.bitmap), thumb, file.name)
          // ⚠️ 只在**这张照片还是当前那张**时才认这个 id：
          //   用户可能在等的时候又换了一张（那会让这个 id 变成上一条会话的）
          if (originalFileRef.current === file) {
            setCurrentSession(id)
            // ★ 建会话送上去的那张图，服务端已经当 `original` + `base` 存了一份
            //   —— 记一笔，第一趟落盘就不用**再传一遍全尺寸底图**（连缩略图）。
            //   不记的话：服务端每收一个 `base` 都存成**新文件**，每条会话会白白
            //   多背一张没人引用的原图和一张缩略图，外加一次白费的整图上传。
            lastPersistedBaseSeqRef.current = baseSeqAtCreate
          }
        } catch (e) {
          console.error('会话没建起来', e)
          noticeBad('这次的改动暂时存不下来（刷新就没了），修图照常。')
        }
      })()
    } catch (e) {
      console.error(e)
      noticeBad('这张图打不开，换一张试试')
    } finally {
      setBusy(null)
      // ★ "这一张开完了"（折了也算 —— 用户已经知道结果了）。切会话那趟看的是
      //   `pickSeqRef > pickSettledSeqRef`（见 `pickSettledSeqRef` 那段）。
      pickSettledSeqRef.current++
    }
  }, [history, say, loadCards, setCurrentSession])

  /**
   * 把"手上这一张"整个放下：照片、对话、参数、快照、会话 id，一件不留。
   *
   * ⚠️ **它只清状态** —— 不发网络、不看 `busy`、不推版本号。那三件事**两条调用
   *   路要的不一样**（见 `startNew` 和 `onSessionDeleted`），摆在这儿就会二选一
   *   错一边。条件留在各自的调用点上，理由也写在那边。
   *
   * ⚠️ **归零前要把 `history` 里那些位图 `close()` 掉**（和 `onPick` 里那段
   *    `bitmapsToClose` 是同一个道理）：不关就是换几次照片把标签页拖垮 ——
   *    原图和每条生成式的 base 都占着 GPU 内存（32 MP 一张约 129 MB）。
   *    副作用留在状态更新外面，别塞进 updater（updater 可能被重放）。
   */
  const resetEditor = useCallback(() => {
    for (const s of bitmapsToClose(history, [])) s.bitmap.close()
    setImage(null)
    setHistory([])
    setMessages([])
    setCards([])
    setParams(ZERO)
    setSavedId(null)
    // ⚠️ 归零 = "这一趟还没挂到服务端上"（下一次上传会建一条新的）。不归零的话，
    //   落盘那个 effect 会带着**新照片**的消息和步骤去写**上一条**会话。
    //   （同一趟里再换一张照片那条路也有这道保险 —— 见 onPick 里 `setCurrentSession(null)`
    //    那一段；这里从另一头把它做成了正经入口。）
    setCurrentSession(null)
    // 上一条照片那些**临时**状态：点选流程、"上次那张要替换掉吗"、原图预览。
    // 留着的话红圈会钉在下一张照片上，而「替换」问的是上一张存过的那条作品。
    setPending(null)
    dismissAsk()
    setOriginalPreview(null)
    originalFileRef.current = null
  }, [history, setCurrentSession, dismissAsk])

  /**
   * 「照着这张调」—— 用户挑了一张参考图（spec §4.6 的"我想要这种色调"）。
   *
   * 整件事**都在本地**：解码参考图 → 两边各缩到 96px 采一遍色 →
   * 拟合出六个参数（纯函数，见 `core/colorMatch.ts`）→ 直接 `setParams`。
   * 不联网、不花钱、几十毫秒。**这也是为什么它不走生成层**：
   * 送进模型去"重画"会把整张脸也重画一遍（脸部 58.6% 像素被改动，见
   * `sensenova-api-facts`），而色调这件事本来就只是个色彩分布的问题。
   *
   * ⚠️ **送进去的是底图（`image`），不是画布上那份带参数渲染过的画面。**
   *   这和"送去生成的必须是当前 base"是同一条铁律的两面：参数不该被算进
   *   这次比较里，否则用户拖过一次滑块再"照着调"，前面那套参数会被叠两次。
   *
   * ⚠️ **参考图用完就关**（`bitmap.close()`）：`decodeImageFile` 给的位图占的是
   *   GPU 内存，为采一次色一直留着它不值 —— 这个项目为这件事写过好几处注释。
   *
   * ⚠️ **它盖掉的是六个参数，清晰度和暗角原样留着**（`MatchedTone` 只有六个键，
   *   想整份替换过不了 typecheck）。那两个跟"参考图长什么样"没关系：
   *   暗角是构图选择，清晰度是局部细节。
   *
   * ⚠️ **故意不弹"这个色调我做不到满分"之类的提示。** 2026-10-02 量过：
   *   八张真实旅游照两两配对（56 对），**48 对**的残差超过肉眼阈值，
   *   而且残差的 **69% 落在明暗轴**（不是颜色）。也就是说"做不到满分"是常态、
   *   不是例外 —— 每次都弹的提示是噪音，不是诚实。这件事属于产品和文档那一层
   *   （见 spec §4.6 那条"未决"），不该做成一个永远在响的弹窗。
   */
  const matchReference = useCallback(async (file: File) => {
    if (!image) return
    let ref: DecodedImage | null = null
    try {
      ref = await decodeImageFile(file)
      // 传的是 `image.bitmap` 而不是 `image`：`Sizable` 要的是"能 drawImage 的东西"
      // 且自带宽高，而 `DecodedImage` 是个壳（位图在 `.bitmap` 上）。
      const { params: matched } = matchToReference(samplePixels(image.bitmap), samplePixels(ref.bitmap))
      setParams(p => ({ ...p, ...matched }))
    } catch {
      noticeBad('这张参考图打不开，换一张试试')
    } finally {
      ref?.bitmap.close()
    }
  }, [image, noticeBad])

  /**
   * 「新的一张」—— 回到"选一张照片"那一屏（§6.4，Task 6）。
   *
   * ⚠️ **它不删当前这条会话**：那条已经在服务端上存着了，左栏「对话」里还找得到。
   *    表现上要和「保存」分清楚 —— 保存是"把这张存进作品"，新的一张是"我再改一张"。
   *
   * ⚠️ **生成在跑的时候不许按**（按钮那边也 disabled 了）：那一次回来时会往
   *    history 里推一步、并且 `setImage` —— 而那时候屏幕上已经什么都没有了，
   *    会凭空长出一张没有会话、也不会落盘的照片。
   */
  const startNew = useCallback(() => {
    if (busy) return
    // ★ 第一句（在动状态之前）：把上一条**还没到点**的那趟落盘提前发出去。
    //   和切会话是同一条路 —— 状态一清，那个 800ms 的闹钟就被 effect 的清理
    //   连根清掉了，用户最后改的那几下会永远丢了（见 `flushPersist`）。
    //   摆在 `busy` 那道守卫**下面**：被挡回去的那一次什么都没发生，
    //   更不该去动落盘。
    flushPersist()
    resetEditor()
  }, [busy, flushPersist, resetEditor])

  /**
   * 用户把**正在改的那一条**从「对话」列表里删掉了（2026-10-02 用户报的那条：
   * 「我把对话的历史删掉了，为什么修图中还是有我上传的照片呢」）。
   *
   * ⚠️ 这件事发生在服务端和那一页上，**App 这边不会自己知道** —— 删除成功后
   *   `SessionsPage` 才把这个 id 交回来。不听的话后果不止"看着奇怪"：`sessionId`
   *   还指着一条**已经不存在的**会话，之后再改什么都打在 404 上（屏幕上只有一句
   *   "刚才那一步没存下来"），刷新一看全没 —— 错了不报错，只是悄悄丢东西。
   *
   * ⚠️ **不是他删的那条就一个字节都不许动**：用户在列表里收拾旧账是常事，
   *   而手上这张可能正改到一半。
   *
   * ★ 和 `startNew` 有三处不同，每一处都有理由：
   *   ① **不 flush，直接把它扔了**：那一趟打的就是刚被删掉的那条，发出去只会
   *      404 —— 那不是"把活儿写完再走"，是把活儿扔进一个已经不存在的地址，
   *      还顺手在屏幕上留一句关于**用户刚亲手删掉的东西**的警报。
   *   ② **不看 `busy`**：`startNew` 忙的时候可以拒绝（那是用户的一次选择，等十几秒
   *      再按就是了），而**删除已经发生了** —— 状态再不清，就是把人留在一条死会话上。
   *   ③ **推一版 `baseSeqRef`**：正在跑的那次生成回来时会拿它跟出发时的版本比，
   *      不一样就自己作废并且**说一声**（见 `applyDecision` 里 `seqAtStart` 那段）。
   *      不推的话它会一头写进刚清空的 history —— 屏幕上凭空长出一张不属于任何会话、
   *      也永远不会落盘的照片，而用户刚刚才亲手删掉一条。
   *      （`startNew` 不用推这一版：它忙的时候直接拒绝了，走不到这个岔口。）
   */
  const onSessionDeleted = useCallback((id: number) => {
    if (id !== sessionIdRef.current) return
    const p = pendingPersistRef.current
    if (p) {
      // ② 的同一个道理：只有"已经不作数的那一趟"才在扔的范围里。**先摘再清计时器**，
      //    别让它到点又跑一遍（`flushPersist` 也是这个顺序）。
      pendingPersistRef.current = null
      clearTimeout(p.timer)
    }
    baseSeqRef.current++
    resetEditor()
  }, [resetEditor])

  const send = useCallback(async (text: string) => {
    const canvas = canvasElRef.current
    if (!canvas || !image || busy) return
    // 这一趟说过的原话。放在守卫之后：被 busy 挡回去的那次根本没送到模型，
    // 不该变成"用户的原话"。
    pendingRef.current = text
    // 用户又开口了 —— 上一条歧义问句就此翻篇：标记和"原来那句话"一起清掉。
    // 不清的话，他改完别的再回头点一下「就改这里」，会把**已经不作数的那件事**
    // 花掉一次生成的钱（12,900 tokens），而且用的是他当时点的那张图。
    setPending(null)
    setMessages(m => [...m, { id: nextId(), role: 'user', text }])
    setCards([])
    setBusy('正在看照片…')
    try {
      // 路由看的是**用户此刻看到的画面**（含已生效的参数），这样模型给的
      // 增量才是相对当前效果的。生成那一路送的是**当前 base**（同样不带
      // 参数——铁律保证，见 spec §3.5），所以两边都不会把颜色烤进像素。
      const preview = await prepareForRouting(canvas)
      const decision = await postRoute({ imageDataUrl: preview.dataUrl, text, params })
      await applyDecision(decision)
    } catch (e) {
      console.error(e)
      // 同上：票失效不是"出了点问题"，是"你得再登录一次"——而这句话只有在
      // 登录页上才成立。回登录页，不是留一句提示。
      if (isUnauthorized(e)) { setUser(null); return }
      say(e instanceof ApiError ? e.message : '出了点问题，再试一次？')
    } finally {
      setBusy(null)
    }
    // `image` 进了守卫，就必须进依赖数组——否则这个回调会永远看到第一次
    // render 的 image（null），上传后一句话都送不出去。
  }, [busy, params, applyDecision, say, image])

  const onCard = useCallback(async (card: SuggestCard) => {
    if (busy) return
    // 卡片也走 applyDecision，所以这里同样要写 —— 否则卡片触发的歧义会拿到
    // **上一次 send 留下的陈旧原话**，用户点完图确认，送上去的是另一句话。
    pendingRef.current = card.editPrompt
    // 点卡片也是"改主意了"：上一条歧义就此翻篇 —— 和 send 里那一行同一个道理。
    // 卡片**会迟到**（超时之后它还在后台跑、回来了照样贴上来），所以"确认条
    // 和卡片同时在屏上"真会发生；不清的话，用户在卡片已经花过一次钱之后
    // 再点那条「就改这里」，会把**已经被取代的那件事**又花一次（12,900 tokens），
    // 而且用的是旧标记 + 旧话。
    setPending(null)
    setMessages(m => [...m, { id: nextId(), role: 'user', text: card.label }])
    setCards([])

    // 纯参数卡片：deltas 是上传时就算好的，**零延迟、零 API 成本**。
    // 这是整条链路上最划算的一处优化——卡片正是上传后最高频的动作。
    if (card.route === 'params') {
      setParams(p => applyDeltas(p, card.paramDeltas))
      // ★ 助手开口那半句全站一个写法：**「好，」**。
      //   原来四种混着（`好啦` / `好，` / `好了` / 模型自己生成的 `好嘞`），
      //   分开看都不难听，摆在一起像不同的人写的（2026-09-30 通读全站文案时发现的）。
      //   欢迎语「准备好啦，说说想怎么改？」不算 —— 那是另一个功能（第一次打招呼），
      //   不是"收到、这就办"的应答。（规范：docs/文案规范.md §二.6）
      say('好，看看这样行不行。')
      return
    }

    // 带生成的那条走正常路径（它会自己 say 一句）
    await applyDecision({
      route: card.route,
      paramDeltas: card.paramDeltas,
      reply: '好，这就去改。',
      editPrompt: card.editPrompt,
      needsDisambiguation: false,
      degraded: false,
    })
  }, [busy, applyDecision, say])

  /** 用户在图上点了一下（画布已经把屏幕坐标换算成 0~1 了）。 */
  const onPickPoint = useCallback((x: number, y: number) => {
    // ⚠️ 这里**不关**点选流程。关了的话，用户点歪之后只剩"确认"（花错钱）和
    // "不用了"（整条流程作废、还得把话重说一遍）两条路，而他要的只是
    // "点错了不亏钱，还能换个地方再点"。marker 是覆盖写的，再点一下就挪过去。
    // 用函数式更新：没在等的时候（null）原样返回 —— 既不必维护一个会变陈的守卫，
    // 也不会把标记写到一个已经翻篇的流程上。
    setPending(p => (p ? { ...p, marker: { x, y } } : p))
  }, [])

  /** 上一条歧义不做数了（用户说「不用了」、跳走、或者换了句话）。一处全清。 */
  const cancelPick = useCallback(() => setPending(null), [])

  /**
   * 用户在图上点过了，点「就改这里」——**到这一步才花钱**。
   *
   * 圈是画进图里送上去的，不是用文字描述位置（spec §6.3 的实测结论：
   * 图上画圈模型能只改标记处，而且红圈本身会被正确擦掉）。
   */
  const confirmMark = useCallback(async () => {
    // busy 闸门：这是**唯一**一条没有它的花钱路径（send / onCard 都有），
    // 而那条确认条在一张卡片自己那次生成**正在跑**的时候还留在屏上过
    // （见 onCard 里的清理）。没有它，两份 postEdit 会并发跑起来，
    // 两轮 setHistory / bitmap.close() 的记账也跟着并发。
    if (busy) return
    if (!marker || !pendingText || !image) return
    const text = pendingText
    setPending(null)
    // ★ 先说话、**拿这条消息的 id**，再拿它去调 runGenerate。
    //   缩略图（`thumbs[m.id]`）和「回到这一步」（`jumpableIds.includes(m.id)`）
    //   两处都是按消息 id 对号的：这里要是图省事写 `nextId()`，那个 id 没有任何
    //   一条消息带着它 —— 两样会**一起静默失效**：用户点完圈，画面上什么都没多，
    //   也没法回到这一步。花钱买来的东西反而看不见，是这个项目最亏的一种错。
    const mid = say('好，就改这里。')
    // 和 applyDecision / send / onCard 一样清掉建议卡片：卡片**会迟到**
    // （上传时那次请求超时后仍在后台跑、回来了照样贴上来），所以"确认条与卡片
    // 同时在屏上"真会发生。那批卡片是按**生成前那张照片**算出来的 —— 不清的话
    // 它们会活过整个生成，生成一结束就又能点，点一下再花一次钱。
    setCards([])
    try {
      const marked = markImage(image.bitmap, marker)
      await runGenerate(text, mid, params, marked)
    } catch (e) {
      console.error(e)
      say('这一步没成功，再试一次？')
    }
  }, [busy, marker, pendingText, image, params, runGenerate, say])

  const onJump = useCallback((id: number) => {
    const target = history.find(s => s.id === id)
    if (!target) return
    // ★ 「回到这一步」也是"改主意了"：上一条歧义就此翻篇 —— 和 send / onCard
    //   里那几行同一个道理，所以用同一个 cancelPick。
    //   这条路径**不需要任何竞态**就够得到：「回到这一步」和缩略图是全仓唯二
    //   没有 busy 闸门的控件，而点选期间 busy 恰好是空的（模型说完"拿不准"
    //   就收工了）。不清的话：点选期间跳走 → 确认条和红圈都还在 → 点「就改这里」
    //   → confirmMark 的四道守卫全过 → 把**旧标记**画在**换过的底图**上、
    //   配旧那句话，然后扣一次生成的钱。
    cancelPick()
    setHistory(prev => {
      const next = jumpTo(prev, id)
      for (const s of bitmapsToClose(prev, next, { protectOriginal: true })) {
        s.bitmap.close()
      }
      return next
    })
    setImage(target.base)
    // 参数也回到那一步。只还原 base 会让画面和滑块对不上，
    // 用户看到的和面板里显示的是两回事。
    setParams(target.params)
  }, [history, cancelPick])

  /**
   * 「再来一版」—— 同一句话，重掷一次。
   *
   * ★ 2026-09-30 加。这是 AI 产品里"每条回复下面那一排操作"里我们真正缺的那个
   * （组件库那边叫 Actions）。为什么对我们尤其有用：**模型是不确定的** ——
   * 同一个 prompt 连打三次，天空的蓝色分别是 (12,133,248) / (0,163,236) /
   * (1,151,237)（09-21 实测）。"这版差一点"本来就该能再掷一次，
   * 而不是让用户把同一句话再打一遍（那样他还会怀疑是自己没说清楚）。
   *
   * 语义 = **回到那一步 + 用它当初那句话重跑**。和「回到这一步」并排出现，
   * 靠 ↶ / ↻ 区分：一个是回去，一个是回去**并且立刻重来**。
   *
   * ⚠️ 它**花一次生成的钱**（约 13,000 tokens），和用户自己再说一遍一样多。
   * 没有做二次确认：这是创作里最正常的一个动作，每次都要多点一下反而烦人。
   * 但**做额度的时候这一下必须算进配额**（设计文档 §6.6 那张表还没实现）。
   *
   * ⚠️ 这里是**唯一**真正拦住它的地方（按钮上那个 disabled 只是反馈）：
   * 忙的时候再掷一次 = 两次生成同时在跑，队列串行也救不回来，钱是两倍。
   */
  const onRerun = useCallback((id: number) => {
    if (busy) return
    const target = history.find(s => s.id === id)
    // 没有 prompt 的步骤（原图那一类）不该出现这颗按钮；真被点到了也什么都不做 ——
    // 不留一个"点了没反应"的按钮。
    if (!target?.prompt) return
    // 先回到那一步（base / 参数 / 缩略图 / 点选清理，全都走同一条路）
    onJump(id)
    const mid = say('好，又出了一版。')
    void runGenerate(target.prompt, mid, target.params, target.base.bitmap)
  }, [busy, history, onJump, say, runGenerate])


  /**
   * 给刚推入的那一步补缩略图。
   *
   * **为什么不在推快照的地方直接抓**：快照是和 `setParams` / `setImage`
   * 同一个批次推入的，那一刻画布还没重画 —— 抓到的会是**上一步的颜色**，
   * 用户看到的小图和点进去的画面就对不上了。
   *
   * 这个 effect 跑在 Canvas 的渲染 effect **之后**（React 的被动 effect
   * 是子先父后），所以它看到的画布已经是这一步的样子了。
   */
  useEffect(() => {
    const canvas = canvasElRef.current
    if (!canvas || history.length === 0) return
    const last = history[history.length - 1]
    if (last.thumb) return           // 已经有了，别重复抓（也防止这个 effect 打转）
    try {
      setHistory(h => attachThumb(h, last.id, makeThumbnail(canvas)))
    } catch (e) {
      // 缩略图是锦上添花的东西，抓不到不该影响用户修图
      console.error('缩略图生成失败（不影响修图）', e)
    }
  }, [history])

  /**
   * 把"现在这一趟"存回服务端。
   *
   * ⚠️ 五件事，一件都不能错：
   *   ① **防抖**：拖一次滑块会推出很多版 —— 不防抖就是每个像素一次 PUT。
   *   ② **不许在底图没换的时候传 `base`** —— 那会多存一个没人引用的文件
   *      （设计文档 §4.3 那条"参数步不产生新图"，落点就在这儿）。
   *   ③ **不许在调用点上 await** —— 用户拖滑块是连续的，等一次网络往返就等于拖不动。
   *   ④ **不许把失败吞掉** —— 静默失败是这个项目最恨的：用户会以为存上了。
   *   ⑤ **`lastPersistedBaseSeqRef` 只在写成功之后才更新** —— 先更新的话，
   *      一次失败会把那一版底图**永久跳过**（后面再也不会重传它）。
   */
  useEffect(() => {
    const last = history[history.length - 1]
    if (sessionId === null || !last) return
    // 底图这一版存过没有？`lastPersistedBaseSeqRef` 只在**写成功**之后才跟进
    // （见 ⑤）——它的初值 -1 表示"一版都还没存过"。
    const changed = baseSeqRef.current !== lastPersistedBaseSeqRef.current
    const snapshot = history.map((s) => ({
      id: s.id, label: s.label, params: s.params, prompt: s.prompt, at: 0,
    }))
    // ⚠️ `ChatMessage` 上**没有 `at`**（这个客户端不显示消息时间），而
    //   `SessionMessage.at` 是必填的 —— 送 0 = "这个信息我们没有"（服务端
    //   `readMessages` 收到缺省时落的也是 0）。**不能在这里现取 `Date.now()`**：
    //   这一串每次落盘都整段重发，`Date.now()` 会把**每条**消息的时间每次改写成
    //   "此刻"，比没有更糟。将来真要在气泡上显示时间，该改的是 `ChatMessage`
    //   （加一个字段、在 `say`/`send` 那几处写进去），不是在这里补一个数。
    const messagesNow = messages.map((m) => ({ ...m, at: 0 }))
    // ★ `params` **必须一起送**，而且**必须在依赖里**。
    //   ⚠️ 这个客户端里"改参数"（拖滑块 / 套预设 / 按重置）**不会**让 `history` 变
    //   —— 那是既有的裁定 ⑤（见 `WorkDetailPage` 那个 `onApply` 的注释）。
    //   所以只盯 `[history, messages]` 的话，用户拖完滑块**一次都不会落盘**，
    //   刷新一下回到拖之前的样子 —— 而验收线第 1 条写着"参数全在"。
    const paramsNow = params
    // ★★ 画布**在这一刻**拿到手，不在发的时候现读（2026-10-01 终审 C1）。
    //
    //   为什么不能在 `run` 里现读 `canvasElRef.current`：画布只在「修图」那一屏
    //   存在（`{view.kind === 'edit' && …}` 一卸载，`Canvas` 那个回调 ref 就把它
    //   置回 null），而**切导航不会让这个 effect 重跑**（依赖里没有 `view`）——
    //   800ms 后闹钟响时用户可能已经在「对话」/「作品」上，现读就是 null，
    //   于是 `run` 里那句 `if (!el)` 把**整份 patch**（messages / steps / params /
    //   base / thumb）一声不吭地全扔掉：用户花了钱生成的那一步永远到不了服务端，
    //   刷新回到生成之前，而且不是"请求失败了"，是**压根没发**。
    //   连 `flushPersist` 也救不回来 —— 它调的是同一个 `run`，被同一句吞掉。
    //
    //   为什么现在拿不会拿到陈的：这个 effect 每次 `history` / `params` 变化都会
    //   重跑，所以这一份记号永远是"最后一次改动那一刻那张画布"。
    //   而**画布卸载之后像素还在**（元素还被这个 ref 引用着，`drawImage` /
    //   `toDataURL` 照常工作）—— 这正是这个修法成立的原因。
    const el = canvasElRef.current

    // ③：这里只**定一个闹钟**，不等任何网络。下一次改动会把这个闹钟重设。
    //
    // ★ 活儿抽成一个 `run`，并且**登记**到 `pendingPersistRef` 上：用户改完
    //   立刻切会话（左栏「对话」里点开一条 / 按「新的一张」）时，`loadSession`
    //   会在改状态之前把它**提前点掉**（`flushPersist`）—— 不登记的话这个闹钟
    //   连响的机会都没有：依赖（`sessionId` 就在里面）一变，下面那句清理就把
    //   它清掉了，上一条最后那几秒的改动永远丢了，且一句话不说。
    const run = (keepalive = false) => {
      const seq = ++persistSeqRef.current
      // ★ "这一趟送出去的是哪一版底图" —— 在这儿（**发出去之前**）就定死。
      //   ⚠️ 别等请求回来再读 `baseSeqRef.current`（见下面 ⑤ 那一行）：
      //   请求在路上时用户完全可能又生成了一版；回来时读到的是**新版本号**，
      //   而服务端手里刚收到的还是**旧底图** —— 那一版新底图紧接着要是失败，
      //   这个记号已经把新版标成"存过了"，它就**永远不会再送**。
      const sending = baseSeqRef.current
      void (async () => {
        try {
          const patch: SessionPatch = { messages: messagesNow, steps: snapshot, params: paramsNow }
          if (changed) {
            if (!el) {
              // ⚠️ 这一句**到得了**（2026-10-01 终审更正：旧注释说它到不了，是错的）。
              //   两种走法都真的会发生，共同点是**这一笔状态变更落在没有画布的那一刻**：
              //   ① 建会话的 id 是在**别的屏**上到位的，而那段窗口里又落过一次生成
              //      （`changed` 因此为真）—— 上传之后马上切走就是这个形状；
              //   ② 一次生成在用户切走**之后**才回来 —— 那一笔 `setHistory` 让 effect
              //   在没有画布的那一刻重跑，`el` 就是 null（这份记号是当场拿的，
              //   不会去复用上一张画布：那张上面画的还是生成**之前**的样子，
              //   拿它顶上去等于把用户花钱生成的这一版**标成已存**，比丢掉更坏）。
              //   **不许静默**：真到了，这一版底图就这么丢了，一句话都不说
              //   正是这个项目最恨的那种失败。
              console.error('落盘时画布不在，这一版底图没存下来')
              return
            }
            // ★ 走 `bitmapToDataUrl(el, 0.9)`（编码前压到 `MAX_DIMENSION`），
            //   **不是** `el.toDataURL` —— 画布按图的大小开，而生成那条路上有个
            //   "**提供方回的图比它声明的更大**"的偏差分支（见上面"以实际为准，
            //   不拉伸"那一段）：4096² 的 JPEG 0.9 能顶到服务端 8MB 那条线
            //   → 413 → 「刚才那一步没存下来」**指错原因**，而且会反复发生。
            //   ⚠️ 压的**只是上路这一份**：画布本身**不许缩** —— 它是工作台，
            //   预览、导出、下一次生成都按它的分辨率走（缩画布 = 每次导出降级）。
            patch.base = bitmapToDataUrl(el, 0.9)
            // ★ 缩略图**跟着 base 一起换**，spec §6.3 要求列表上是「最后那张」的样子。
            //   不换的话，列表永远显示刚上传那张原图 —— 用户改了半天，左栏「对话」里
            //   还是那张没改过的照片，而且**不报错**。
            //   只在 `changed` 那一支里做：图没变的时候重做一张是白费（而且会让
            //   服务端把好好的缩略图删了重存）。
            patch.thumb = makeThumbnail(el, GALLERY_THUMB_MAX_SIDE)
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
          // ⑤：**写成功之后**才记下"这一版底图存过了" —— 记的是**这一趟送出去的
          //   那版**（`sending`），不是"回来时的当前版"（理由见上面 `sending`）。
          //
          // ★ 但这句只在"**我回来时还是当时那条会话**"时才算数（`sessionId` 是
          //   这一趟闭包里那条，`sessionIdRef` 是**回来时**人站的那条）：
          //   切走之后才回来的应答，`loadSession` 已经替新会话把记号对齐过了
          //   （见它那批状态写里的 `lastPersistedBaseSeqRef`）—— 这时候再按
          //   上一条的版本号拨回去，新会话的下一次落盘就会**重传一整张服务端
          //   手里已经有的底图**（外加一次缩略图重做、还让服务端把好好的缩略图
          //   删了重存）。切走那趟的 `flushPersist` 让这条时序从"几乎撞不上"
          //   变成常事（2026-10-01 评审抓到的）。
          //   ⚠️ 用 `sessionIdRef`（回来时的）不是 `sessionId`（发出去时的）——
          //   后者永远等于自己，这个判据就没了。
          if (changed && sessionIdRef.current === sessionId) {
            lastPersistedBaseSeqRef.current = sending
          }
        } catch (e) {
          // 只认**最新**那一次失败 —— 早先那几次可能已经被后一次覆盖掉了，
          // 那时候弹"没存下来"是在说一件已经不成立的事
          if (seq === persistSeqRef.current) {
            console.error('这一步没存下来', e)
            noticeBad('刚才那一步没存下来，刷新可能接不上。')
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
  }, [history, messages, params, sessionId])

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

  // ── 左栏导航 + 网址（Task 10） ──────────────────────────────────────
  //
  // **不引路由库**：零依赖是硬约束，而我们要的只有两条路径 + 一条带参数的
  // —— `history.pushState` 就够了。引一个路由库来管三条路径，是拿一个新依赖
  // 换 20 行代码。路径怎么认、怎么拼，规则**只有一份**（ui/view.ts 那个纯函数），
  // 不散在这里。

  /** 现在在哪一屏。**它是切界面唯一会动的东西** —— 别的 state 一个都不碰，
   *  于是"切导航不丢工作"是结构上的必然，不是"记得保存"（§3.2）。 */
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname))

  /**
   * 点导航：改状态，顺手把地址栏换成对应的那条。
   *
   *  这两条语句**谁先谁后无所谓**：`pushState` 不会触发 `popstate`（规范就这么定的），
   *  `setView` 也不碰历史栈 —— 先写地址只是读起来顺，别在这儿找讲究。
   *
   *  ⚠️ 必须写 `window.history`（不能省成 `history`）：这个组件里有一份**同名**的
   *  撤销历史 `const [history, setHistory] = useState<Snapshot[]>([])`，它把全局那个
   *  `history` 遮住了 —— 省掉 `window.` 是个**编译期**的错
   *  （`TS2339: Property 'pushState' does not exist on type 'Snapshot[]'`）。
   *  写全是为了让下一个人一眼看见"要的是浏览器那个 history"，而不是先去读一遍
   *  类型错误才知道。
   *
   *  ⚠️ `replace`：**不往历史栈里压新条目**，只把当前这条换掉。
   *  只有一处用它 —— 登录着的人打开落地页时那个自动跳转。用 push 的话历史栈里
   *  会留下一条 `/`，用户按后退 → 又跳回来 → **按几次都出不去**。
   */
  const go = useCallback((v: View, opts?: { replace?: boolean }) => {
    // ★ 去**门面**那一页时走 `FRONT_PAGE`（= `/?home=1`），不是 `pathOf` 给的
    //  `/`（2026-10-03）。差别只在"谁走过去"：`/` 是这一页的正身（直接输网址、
    //  发链接都走它），而**从 App 里主动走过去**得带上那个参数 —— 不带的话
    //  下面那条自动跳转立刻把人送回 `/app`，点「首页」像是没反应。
    //  ⚠️ 判断要写在**这一处**（写网址只有这一处），别在 Nav 里另开一条 pushState
    //   —— 那样"哪一屏对应哪个网址"就有了两份，迟早对不上。
    const p = v.kind === 'landing' ? FRONT_PAGE : pathOf(v)
    // ⚠️ "是不是已经在这一页上了"比的是 **`pathOf`**（不带参数的那个网址），
    // 不是上面那个 `p`：站在 `/?home=1` 上再点一次「首页」，地址栏已经是它了，
    // 不该再压一条 —— 压了的话后退要按好几下才出得去。
    if (location.pathname !== pathOf(v)) {
      if (opts?.replace) window.history.replaceState(null, '', p)
      else window.history.pushState(null, '', p)
    }
    setView(v)
  }, [])

  // 浏览器的后退 / 前进：跟着地址走
  useEffect(() => {
    const onPop = () => setView(viewFromPath(location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /**
   * 已经登录的人打开 `/`（落地页）→ **直接送去 App**。
   *
   * ⚠️ 用 `replace`，不能 push：营销页是给访客看的，自己人每次打开都撞上它是
   * 打扰；而 push 会在历史栈里留下一条 `/`，用户一按后退又跳回来 —— 出不去。
   *
   * ⚠️ 它**只认自己人**：没登录的访客停在落地页上（那正是这一页存在的意义）。
   * `checking` 那一段要等 —— 还没问出"我是谁"就跳，会把每个登录着的人
   * 先闪一下落地页再走。
   *
   * ★ 2026-10-03：**特意来的不算**（`?home=1`，见 `ui/view.ts` 的 `FRONT_PAGE`）。
   * 左栏底下那颗「首页」把人送到 `/?home=1`，这一条认出来就得让路 —— 不让的话
   * 那颗按钮会"点了没反应"（推过去、立刻被撵回来），而且地址栏还会被改回 `/app`。
   * 它守的仍然是原来那句话：**回访**的人不必每次打开都撞上营销页。
   *
   * ⚠️ 判据读的是 **`location.search`**，不是 `view` 上挂一个字段：按后退/前进
   * 回来时 `view` 是 `viewFromPath(pathname)` 拼的（它看不见 `?` 后面那截），
   * 挂在 view 上的话，从门面点「免费开始」进 App 再按后退 —— 人会被撵回来。
   */
  useEffect(() => {
    if (!checking && user && view.kind === 'landing' && !askedForFrontPage(location.search))
      go({ kind: 'edit' }, { replace: true })
  }, [checking, user, view, go])

  /**
   * 标签页那个标题。★ 2026-10-01 加的。
   *
   * `index.html` 里写死的标题是**落地页**那句（「说句话，照片就修好了」），
   * 而且必须写死在文件里 —— 社交抓取器和 AI 爬虫都不跑 JS，靠 JS 注入的标题
   * 它们一个字都读不到。代价是**每一屏一进来都顶着那句营销文案**，所以
   * App 这几屏要把它换回产品名。
   *
   * 落地页那一支不管：它自己的 effect 会设成同一句、离开时还原
   * （`LandingPage.tsx` 里那个 prevTitle）。
   */
  useEffect(() => {
    if (view.kind !== 'landing') document.title = 'RuiXing'
  }, [view.kind])

  // 还没问出"我是谁"之前什么都别显示 —— 认出没登录的访客是**一次网络往返**，
  // 直接按 user === null 渲染的话，每个登录着的用户回访时都会先看到登录页闪一下。
  //
  // ⚠️ 这一屏**要跟着门面换色**：落地页是浅色的，而 App 这套"正在打开…"是深色的，
  // 直接用它会在浅色页面前先闪一块深色。地址栏在这一刻**已经**能看出是落地页了
  // （`view` 是从 `location.pathname` 来的，不用等网络），所以这儿分辨得出来。
  if (checking) {
    return (
      <div className={`app-loading${view.kind === 'landing' ? ' lp-loading' : ''}`}>正在打开…</div>
    )
  }

  // ★ **落地页在这一步之前就返回**（2026-09-30 加）。
  //   它必须排在 `!user` 那条**前面**：落地页是给**没登录的访客**看的，
  //   排到后面就永远轮不到它 —— 访客会直接撞上登录页，而门口那一页白做了。
  //   （登录着的人到不了这一条：上面那个 effect 已经把他们送去 `/app` 了。
  //    真到得了也只是多看一眼门面，不会坏。）
  if (view.kind === 'landing') return <LandingPage onEnter={() => go({ kind: 'edit' })} />

  // 没登录就只有登录页。底下那些修图的东西一样都不挂载：三个 AI 接口现在
  // 都只认登录过的人（否则 401），挂上去也只是让用户先挑好照片再被拒。
  //
  // `onDone` 里**重新问一次 `/api/me`**，而不是让登录页回传一个名字去拼一个
  // `{ id: 0, ... }` —— 那个 id 不是任何一个真 id，是内存里的一个假人。
  //
  // 返回那个 promise（而不是用花括号丢掉它）：登录页要 `await` 它，好让
  // 「稍等…」盖住**整个**跟随请求 —— 否则 `/api/me` 还在半路时按钮就变回可点，
  // 用户看到"点完什么都没发生"，那正是最容易诱发再点一下的形状。
  // `me()` 的契约是永不抛（401 → null），所以这个 promise 不会 reject。
  if (!user) return <LoginPage onDone={() => me().then(setUser)} />

  return (
    <div className="shell">
      {/* 左栏在**所有**界面里都在：作品页、详情页是同一个壳，换的只是右边那一格。 */}
      <Nav view={view} onGo={go} />

      {view.kind === 'edit' && (
        <div className="app">
          <header className="topbar">
            {/* 玫瑰标志 + 名字。**`alt=""` 是有意的** —— 旁边就是 "RuiXing" 这行字，
                读屏的人听一遍名字就够了，图片再报一次等于同一个名字念两遍。
                （图片本身是 2026-09-29 用户拍板的粉玫瑰，源文件在 src/assets/logo/。）

                ⚠️ 用的是**彩色版**，不是单色版：顶栏是深底，单色深版（墨色）在上面
                根本看不见，而单色浅版（白色）会把品牌唯一的颜色丢掉。
                26px 是试出来的 —— 再小粉色就糊成一个点。 */}
            <span className="brand">
              <img className="brand-mark" src={logoMark} alt="" width={26} height={26} />
              RuiXing
            </span>
            {image && (
              <div className="actions">
                <button onClick={() => setShowPanel(v => !v)}>调色</button>
                {/* 这一格是**"把图给我"**，只是给法分两种，按这个设备认不认
                    图片分享来选（`canShare` 只在挂载时算一次：设备能力不会中途变）。
                    · 认 → 「分享」：弹系统面板，手机上一步选微信，跳过翻文件管理器。
                    · 不认 → 「下载」：桌面 Chrome 就是这一档，见 onDownload
                      —— 在那之前**桌面上根本没有把图拿到手的路**。
                    两条路都给同一个东西（用户修好的那张图），所以它们是**同一格
                    的两种长相**，不是两个按钮。 */}
                {canShare ? (
                  <Btn className="primary" onClick={() => onShare()} disabled={delivering !== null}>
                    {delivering === 'share' ? '准备中…' : '分享'}
                  </Btn>
                ) : (
                  <Btn className="primary" onClick={onDownload} disabled={delivering !== null}>
                    {delivering === 'download' ? '准备中…' : '下载'}
                  </Btn>
                )}
                {/* 「保存」= 存进作品集（§3.4）—— 它不再下载，所以走的是 `onSave`。 */}
                <button onClick={onSave} disabled={delivering !== null}>
                  {delivering === 'save' ? '准备中…' : '保存'}
                </button>
                {/* 「新的一张」= 回到上传前那一屏去选下一张（§6.4）——
                    它是**"我再改一张"**，和「保存」（把这张存进作品）是两件事。
                    ⚠️ 它**不删**当前这条会话：那条已经在服务端上存着了，左栏
                      「对话」里还找得到。
                    ⚠️ 忙的时候 disabled：生成在跑的那十几秒里，那一次回来时会往
                       history 里写一步，而那时候这张照片早就不在屏幕上了。 */}
                <button onClick={startNew} disabled={busy !== null}>新的一张</button>
              </div>
            )}
            {/* 用户管理收在右上角（§3.2）—— 它一辈子点几次，不配占一个一级位置。
                ⚠️ aria-label 是**必须**的，不是装饰：按钮里只有一颗 emoji，
                读屏软件要么念不出来、要么念成一串莫名其妙的外文名，用户
                根本不知道这个按钮是干什么的。（品牌名那边的 `alt=""` 是同一件
                事的另一面：旁边已经有字，就不必让读屏的人听两遍。）

                ⚠️ 它**是 `.actions` 的兄弟，不在 `.actions` 里**。两条理由：
                · `.actions` 是"这张图能拿去哪儿"（分享/下载/保存），只在**有图**
                  的时候出现；用户管理没有图也在，混在一起会让它跟着一起消失；
                · 有两条测试按结构钉着 `.actions button` 恰好是哪几颗
                  （见 App.test.tsx 的 topbarButtons；2026-10-01 Task 6 起是
                  **四颗**——末尾多了「新的一张」§6.4），混进去等于改了一个
                  没人说要改的界面。
                放**最后一个**子节点是为了让它钉住右上角：`.topbar` 是
                space-between，第三个孩子会被排到正中间去。 */}
            <button className="user-btn" onClick={() => go({ kind: 'account' })}
                    aria-label="用户管理"><User size={17} aria-hidden="true" /></button>
          </header>

          {/* 通报条（取代了原来的 window.alert）。它和下面那两条横幅是**三种东西**：
              这条是"这件事没成"的通报、可以收走；`.ask` 是**在问用户一句话**；
              `.save-fail` 是"图还在，先拿到手"（自带下载按钮，而且不许关）。
              三块都住在顶栏下面、都按"一整条横幅"排，所以它们并排出现时读起来
              是一列消息，不是三坨按钮。 */}
          {notice && (
            <div className={notice.tone === 'ok' ? 'notice ok' : 'notice'}>
              <p>{notice.text}</p>
              <button onClick={() => setNotice(null)}>知道了</button>
            </div>
          )}

          {/* 「上次那张要替换掉吗？」（§3.4）—— 同一张照片存第二次才会出现。
              ⚠️ **不放进 `.topbar`**：那一条是 `justify-content: space-between`
              的一行，塞进去会把品牌名和那两个按钮挤成一团（`check:layout` 量的
              正是顶栏会不会被挤爆）。贴在顶栏**下面**也就贴在用户刚按的那个
              按钮的正下方 —— 问他话的地方就是他按的地方。 */}
          {asking && (
            <div className="ask">
              <p>上次那张要替换掉吗？</p>
              <button onClick={() => answerAsk(savedId)}>替换</button>
              <button onClick={() => answerAsk(null)}>再存一张</button>
            </div>
          )}

          {/* 存不进去（§6.6 ①）：**改好的图只在屏幕上**，所以当场给一个能拿到它
              的按钮。§10 说这条最容易漏 —— 漏了的话用户一关页面，那张图就没了，
              而他那一刻要的是发朋友圈；存不下是**我们这边的限制**。 */}
          {saveFail && (
            <div className="save-fail">
              {/* §6.6 ②：明确告诉他，不含糊 —— 只说"存不进去"他会以为图也没了。
                  ⚠️ **两种失败要分两句话说。** `blob` 为 null 意味着图**根本没做出来**
                  （`buildExportBlob` 那步就炸了），这时候说"图还在"是**假的** ——
                  用户会去找一个屏幕上根本不存在的按钮。有图才说"图还在，先拿到手"。
                  变异：把下面这个三目压成永远走第一句 → 那条断言红。
                  ⚠️ **说的是「刚才那张」，不是「这一张」**（2026-09-25 改）。这条横幅
                  **不随画面变消失**（故意的：清掉的话用户就再也拿不到那张图了，而他
                  关掉横幅之后是**真的**拿不到了）。而屏幕上的画面是会变的 —— 他回头
                  又改了一版（「把后面那个人去掉」生成一张新的底，或者点「回到这一步」
                  退回某一步），这时候屏幕上那张**就不是**失败那一刻那张了：
                  「这一张」指向屏幕上这张，而按钮给的是 `saveFail.blob` 里那张
                  （失败那一刻做出来的）。**一句话和它对不上的行为，比没有这句话更糟。**
                  （不是"换一张照片"那个场景：应用里没有换图入口 —— Uploader 只在
                  还没有图的时候渲染，换图的唯一动作是重开一次，而重开会把横幅
                  一起清掉，所以横幅边上从来不会出现"另一张照片"。见 App.test.tsx
                  那条「换一张照片」的注释。）
                  变异：把「刚才那张」改回「这一张」→ 那条「存失败之后又改了一版」的断言红。 */}
              {saveFail.blob
                ? <p>刚才那张没能存进作品集。图还在，先拿到手：</p>
                : <p>刚才那张没能存进作品集，图也没能导出来。再点一次「保存」试试。</p>}
              {/* 把"为什么"也说出来 —— 服务端给的那句话（「这张图太大了，存不下」）
                  比「没存进去」有用得多。存了这个字段却从不显示，等于白存。 */}
              <p className="save-fail-why">{saveFail.why}</p>
              {saveFail.blob && (
                <Btn
                  className="download"
                  // ⚠️ 这个 `!` 是**结构上**安全的，不是"我保证"：它上面那行
                  //    `{saveFail.blob &&` 已经把 false 那一支挡掉了，能渲染到这里
                  //    就说明 blob 非 null。（而且不能把 `&&` 换成 `?.` —— `&&`
                  //    也是"按钮出不出现"本身：没图就不该有这个按钮。）
                  //    **别照着这里在别处也随手加 `!`**：换个地方它可能真的会是 null。
                  onClick={() => downloadImage(saveFail.blob!, saveFail.name)}
                >
                  下载到电脑
                </Btn>
              )}
              <button onClick={() => setSaveFail(null)}>知道了</button>
            </div>
          )}

          {!image && (
            <main className="stage">
              {busy ? <div className="hint">{busy}</div> : <Uploader onPick={onPick} />}
            </main>
          )}

          {image && (
            <main className="workspace">
              <div className="stage">
                {/* params 直接传下去：[-100,100] → [-1,1] 的换算只发生在
                    TonePipeline.render 里（唯一入口） */}
                <Canvas
                  image={image}
                  params={params}
                  canvasRef={canvasElRef}
                  originalPreview={originalPreview}
                  picking={picking}
                  marker={marker}
                  onPickPoint={onPickPoint}
                  onFail={noticeBad}
                />
              </div>
              <ChatPanel
                messages={messages}
                cards={cards}
                busy={busy}
                suggesting={suggesting}
                onSend={send}
                onStop={stopGeneration}
                onCard={onCard}
                onJump={onJump}
                onRerun={onRerun}
                // 只有"记着当初那句话"的步骤才给「再来一版」——
                // 原图没有那句话（`prompt` 缺席），所以它那颗按钮不会出现。
                rerunnable={history.filter(s => s.prompt).map(s => s.id)}
                jumpableIds={history.map(s => s.id)}
                thumbs={Object.fromEntries(history.map(s => [s.id, s.thumb]))}
                // marker 非空必然 picking 为真（两者出自同一个对象），所以这里
                // 不必再 or 一次 —— 从 `pending` 推出来的东西不可能互相打架。
                marking={picking}
                canConfirmMark={!!marker && !!pendingText}
                onConfirmMark={confirmMark}
                onCancelMark={cancelPick}
              />
            </main>
          )}

          {image && showPanel && (
            <AdjustmentPanel
              value={params}
              onChange={setParams}
              onReset={() => setParams(ZERO)}
              onMatchReference={file => void matchReference(file)}
            />
          )}
        </div>
      )}

      {/* 作品页（Task 11）：按天分组、先摆 60 张、名字就是时间所以搜日期也能搜到。
          `onOpen` 只把 id 交出去 —— 拼网址那条规则仍然只有一份（ui/view.ts），
          组件自己不认识"网址"这回事。 */}
      {/* 对话列表（Task 6，§6.1）：**过程**的家 —— 改过哪些。
          · `onOpen` 走的就是 Task 5 那条恢复路（`loadSession`），只不过这次接的是
            **用户点的那一条**；点完立刻切到修图页，接回来的那几趟网络往返期间屏幕上
            有一句"正在打开这条对话…"（不然那一刻他会看到"选一张照片"那一屏，
            以为这条会话没了）。
          · `onNew` 和顶栏那颗「新的一张」是同一件事（回到上传前那一屏）。 */}
      {view.kind === 'sessions' && (
        <SessionsPage
          onOpen={(id) => { go({ kind: 'edit' }); void loadSession(id, 'open') }}
          onNew={() => { startNew(); go({ kind: 'edit' }) }}
          // ★ 删掉**正在改的那条**时，App 这边也得知道（2026-10-02 用户报的
          //   "删了对话，修图里那张照片还在"）。理由和取舍见 `onSessionDeleted`。
          onDeleted={onSessionDeleted}
        />
      )}
      {view.kind === 'gallery' && <GalleryPage onOpen={(id) => go({ kind: 'work', id })} />}
      {view.kind === 'work' && (
        <WorkDetailPage
          id={view.id}
          onBack={() => go({ kind: 'gallery' })}
          canApply={image !== null}
          onApply={(p) => {
            // ★ 裸调，和滑块 / 预设 / 重置**同级** —— 改 params 从来不 push 快照，
            //   「套用」也不该是例外（裁定 ⑤）。快照是给"生成式编辑"用的。
            setParams(p)
            go({ kind: 'edit' })
          }}
        />
      )}
      {/* 用户管理（§3.6）。
          ⚠️ **不往这一页传作品数**：App 这一层根本没有作品列表（它住在
          GalleryPage 自己肚子里），而第一版传死了一个 `0` —— 于是它对每个
          存过作品的人都写"0 张作品"（用户自己的数据被说成假的）。
          现在由这一页自己拉一次（`GET /api/works` 只回元数据、不带图）。
          退出登录照 App 里那一贯的做法把人送回 LoginPage（`setUser(null)`）：
          和"票过期了"（见 isUnauthorized 那一段）走的是同一条路。 */}
      {view.kind === 'account' && (
        <AccountPage
          user={user}
          // 「模型」那一行从这儿出发（§3.6）。**只传 go，不传网址** ——
          // "哪一页对应哪个网址"只有 ui/view.ts 说了算（和上面作品页同一条规矩）。
          onGo={go}
          onSignedOut={() => setUser(null)}
        />
      )}
      {/* 模型设置（§7.4，Task 9）。*它自己不拉名单之外的东西* ——
          这一页要用的清单（几套配置、哪套在用）全从 `/api/models` 来，
          不进 App 这层状态：那是"设置"，不是修图现场，别让两处各存一份。 */}
      {view.kind === 'models' && <ModelSettings />}
    </div>
  )
}
