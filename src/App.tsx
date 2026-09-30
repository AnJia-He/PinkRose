import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import ChatPanel, { type ChatMessage } from './ui/ChatPanel'
import { LoginPage } from './ui/LoginPage'
import { GalleryPage } from './ui/GalleryPage'
import { WorkDetailPage } from './ui/WorkDetailPage'
import { AccountPage } from './ui/AccountPage'
import { ModelSettings } from './ui/ModelSettings'
import LandingPage from './ui/LandingPage'
import { Nav } from './ui/Nav'
import logoMark from './assets/logo/rose.svg'
import { pathOf, viewFromPath, type View } from './ui/view'
import { me, type AccountUser } from './api/account'
import { createWork, replaceWork } from './api/works'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { resizeBitmap } from './image/resize'
import { fitToLimit, probeLimit } from './render/limits'
import { applyDeltas, ZERO, type Adjustments } from '../shared/adjustments.ts'
import {
  blobToDataUrl, buildExportBlob, buildFilename, canShareImage, downloadImage, shareImage,
} from './export/save'
import { prepareForModel, prepareForRouting, type Sizable } from './image/prepare'
import { ApiError, isAbort, postEdit, postRoute, postSuggest } from './api/client'
import { bitmapsToClose, attachThumb, jumpTo, pushSnapshot, type Snapshot } from './core/history'
import { GALLERY_THUMB_MAX_SIDE, makeThumbnail } from './core/thumbnail'
import { markImage, type NormPoint } from './image/mark'
import type { RouteDecision, SuggestCard } from '../shared/protocol.ts'
import type { Recipe } from '../shared/works.ts'

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

/**
 * 这一趟失败，是不是"票不管用了"（而不是"这次编辑没成"）？
 *
 * 票会中途失效，而且不止一条路：30 天到期、**在别的设备改了密码**（签名里掺着
 * 密码哈希，老票自己就验不过了）、`.env` 里换了 SESSION_SECRET、库被重建、
 * 或者被 CSRF 打一次 `/api/logout`。这些情形后端回的都是 UNAUTHORIZED。
 *
 * ⚠️ **认出来之后必须把人放回登录页**，不能只在聊天里说一句「先登录一下」：
 * 这一段界面上没有"退出"按钮、也没有用户管理页，说了那句话而界面上没有任何
 * 回到登录页的路，用户就只剩**刷新页面**这一条出路 —— 那和 2d333bb 修掉的是
 * 同一个形状的死胡同（"只能靠刷新脱身"）。
 *
 * 置空 `user` 而不是整页重载：App 不卸载，用户重新登录之后**修图状态原样还在**。
 */
const isUnauthorized = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'UNAUTHORIZED'

/** 「按住看原图」那张预览的边长上限。
 *  不直接拿原图：3000 万像素重新上传一次纹理很贵，而"看原图"永远是在
 *  屏幕大小上比的，1280 已经看不出和原图的差别。 */
const ORIGINAL_PREVIEW_MAX_SIDE = 1280

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
  /**
   * 正在跑的那一次**生成**的取消开关（null = 现在没有生成在跑）。
   *
   * ★ 2026-09-30 加，为「停止」按钮。⚠️ 用 ref 不用 state：它只在
   * "按下停止"和"这一次跑完"两个时刻被读，**从来不需要触发重渲染** ——
   * 放进 state 只会让每次生成多两次没用的 render。
   * 而且它必须**按次**清（`if (editAbortRef.current === ac)`），
   * 不能跑完就无脑置 null：那样后一次的 controller 会被前一次的收尾抹掉。
   */
  const editAbortRef = useRef<AbortController | null>(null)
  /** 正在导出的是哪一个按钮（null = 没在忙）。几个按钮共用一个"忙"，
   *  但只有被按的那个显示「准备中…」—— 一起变会像出了几件事。 */
  const [delivering, setDelivering] = useState<'share' | 'download' | 'save' | null>(null)
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
  /** 非 null = 正在问"上次那张要替换掉吗"，手里攥着刚做好的那张图。
   *
   *  ⚠️ **配方是"问的那一刻"那一份，不是回答那一刻的**（终审 M4）。`blob` 是
   *  按下「保存」时导出的，而 `params` / `messages` 若等到他回答时现读，中间他
   *  回头又改了一版（或又生成了一张）就会**张冠李戴**：存进去的图是旧那张、
   *  配方却是新那套 —— 详情页会把一套这张图上根本没发生过的调整当教学讲给他
   *  （§3.5.1 说这一页的全部价值就在"配方是真的"）。窗口很窄，但后果正好落在
   *  那个价值上。 */
  const [asking, setAsking] =
    useState<{ blob: Blob; name: string; recipe: Recipe } | null>(null)
  /** 存失败时把图和名字留在这儿 —— **它是那个「下载到电脑」按钮的全部依据**（§6.6 ①）。
   *  ⚠️ `blob` 为 null 是**另一种失败**：图根本没做出来（`buildExportBlob` 那步就炸了）。
   *  那时候没有东西能给用户，说的话也不能是"图还在" —— 那是骗人（他会去找一个
   *  屏幕上根本不存在的按钮）。 */
  const [saveFail, setSaveFail] =
    useState<{ blob: Blob | null; name: string; why: string } | null>(null)
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
  /** 用户**这一趟说过的原话**（send / 卡片各写各的）。
   *  模型说拿不准时要把它留到用户点完图 —— 届时"原来那句话"是**那一刻**的那句，
   *  不是某个 state 里可能已经翻篇的那句。 */
  const pendingRef = useRef<string | null>(null)

  const nextId = () => ++idRef.current

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

  /** 追加一条助手消息，返回它的 id —— 快照要用同一个 id 挂「回到这一步」。 */
  const say = useCallback((text: string): number => {
    const id = nextId()
    setMessages(m => [...m, { id, role: 'assistant', text }])
    return id
  }, [])

  /**
   * 生成式编辑：换掉 base，**params 一个都不动**。
   *
   * 送模型的是**当前的 base**（`source`）——不是最初那张原图，也不是画布。
   * 送画布不行：上面已经带了用户调好的颜色，送去会被模型烤进像素，回来再被
   * params 作用一次——颜色炸掉。送原图也不行：第二次生成会把第一次花钱改出来
   * 的东西整个丢掉（spec §3.5 的 2026-09-22 更正）。base 由铁律保证永远不带
   * 参数，又是累积的，两个要求它同时满足。
   *
   * `source` 由调用方（applyDecision）显式传入，不在这里读某个 ref：
   * 送哪张图是**调用点的决定**，而 ref 会跨 render 变陈。
   *
   * 入参类型是 `Sizable`（能 drawImage 的东西）而不是 `DecodedImage`：
   * 图上点选那条路送的是**画过圈的一张临时画布**（见 markImage），
   * 要 `DecodedImage` 的话就得为它再造一张位图、用完还得记着关掉 —— 画布
   * 交给 GC 就行，没有那笔 GPU 内存的账。
   *
   * 用户当前的参数值作为**文本上下文**已经由服务端交给 LLM 让它补偿
   * （spec §3.5：确定性比聪明重要）。
   */
  const runGenerate = useCallback(async (
    editPrompt: string, messageId: number, paramsAtStep: Adjustments,
    source: Sizable,
  ) => {
    if (!editPrompt) return
    // ★ 一次生成 = 一个 controller。「停止」按的就是它（见 stopGeneration）。
    const ac = new AbortController()
    editAbortRef.current = ac
    setBusy('正在改…大约 10 秒')
    try {
      // source 直接就是能 drawImage 的东西（位图或画布），不用再拆一层
      const prepared = await prepareForModel(source)
      const out = await postEdit({
        imageDataUrl: prepared.dataUrl,
        editPrompt,
        width: prepared.width,
        height: prepared.height,
      }, ac.signal)
      const blob = await (await fetch(out.imageDataUrl)).blob()
      const bitmap = await createImageBitmap(blob)
      // 尺寸以**实际拿到的像素**为准，绝不按 out.width/height 拉伸：
      // 后者是服务端回显的请求尺寸（声明），拿它去设 canvas 会把照片拉变形。
      // 声明与实物不一致时留下告警，让这种事可观测，而不是静默。
      if (bitmap.width !== out.width || bitmap.height !== out.height) {
        console.warn(
          `[edit] 回图尺寸与声明不符：声明 ${out.width}x${out.height}，` +
          `实际 ${bitmap.width}x${bitmap.height}（以实际为准，不拉伸）`)
      }
      const nextBase: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height }
      // 底图换了一版 —— 上传时那批建议卡片从这一刻起作废（见 loadCards）。
      baseSeqRef.current++

      setHistory(prev => {
        const next = pushSnapshot(prev, {
          id: messageId, label: '生成式编辑',
          // ★ 记住用户当初那句话 —— 「再来一版」靠它重跑（见 onRerun）。
          //   存的是**模型给的那句英文 editPrompt**（`applyDecision` 从决策里
          //   传下来的），不是用户的中文原话：重跑要的是"当初送去生成的那一份"，
          //   中文那句还得再过一遍模型才能变成它，而重跑不该再花一次路由的钱。
          //   （"保留人脸"那半句是服务端 buildEditPrompt 补的，重跑同样会补。）
          prompt: editPrompt,
          base: nextBase, params: paramsAtStep, isOriginal: false, thumb: '',
        })
        // 被挤出去的位图要释放；原图永远不关（"回到原图"还要用它）。
        // close() 是幂等的，StrictMode 双调用 updater 也安全。
        for (const s of bitmapsToClose(prev, next, { protectOriginal: true })) {
          s.bitmap.close()
        }
        return next
      })
      setImage(nextBase)
      // ↑ 只换 base。params 原封不动继续生效 —— 整个数据模型的基石。
    } catch (e) {
      // ★ 用户按了「停止」——**这不是失败**。
      //   三件事都不能做：不能说"这次没改成功"（他主动叫停的，说那句像在怪他）、
      //   不能动 params（铁律照旧）、更不能把票失效那套跑一遍。
      //   只说一句"停了"，让这一轮有个收尾 —— 什么都不说的话，那个"正在改…"
      //   气泡直接消失，用户会怀疑到底停没停。
      if (isAbort(e)) { say('停了。'); return }
      // 失败时用户的参数一点都不丢（spec §4.7 的铁律）。
      // 只加一句提示，绝不去动 params。
      console.error(e)
      // 票中途失效 → 回登录页（见 isUnauthorized）。这一句和下面那句 say 是
      // **互斥**的：说"没改成"和"你被登出了"是两件事，不能一起说。
      if (isUnauthorized(e)) { setUser(null); return }
      say(e instanceof ApiError ? e.message : '这次没改成功，再试一次？')
    } finally {
      // 只有"还是我这一次"才清 —— 别把后一次的 controller 抹掉
      if (editAbortRef.current === ac) editAbortRef.current = null
      setBusy(null)
    }
  }, [say])

  /**
   * 「停止」—— 把这一次生成掐掉。
   *
   * ★ 2026-09-30 加。为什么值得一个专门的按钮：AI 产品里这个位置**本来就该
   * 是它** —— 生成中那颗按钮在 ChatGPT / Claude / Gemini 上是「停止」，
   * 在组件库（Ant Design X 的 Sender）里是一个 `loading` 态。我们原来那十几秒
   * 里发送键只是 `disabled`，用户**没有任何出口**，只能盯着"正在改…大约 10 秒"。
   *
   * ⚠️ **它救的不是钱。** 请求发出去之后，上游那一次多半已经在算了，
   *    tokens 该花还是花。它救的是两件事：① 用户不用干等；② **服务端跟着停**
   *    —— 不跟的话那个串行队列被占满，用户停完马上说的下一句话要白等十几秒，
   *    比没有这个按钮还糟（前端 abort 会让浏览器掐断连接，服务端在
   *    app.ts 的 /api/edit 里挂在 `res` 的 close 上跟着 abort 上游）。
   */
  const stopGeneration = useCallback(() => {
    editAbortRef.current?.abort()
  }, [])

  /** 应用一个决策：参数走本地立刻生效，生成式走云端。 */
  const applyDecision = useCallback(async (d: RouteDecision) => {
    // 铁律：增量的叠加与钳制交给确定性代码，LLM 只负责"大概要多少"。
    // 这里显式算出新值（而不是用函数式更新），因为生成那一步的快照要用它。
    const nextParams = (d.route === 'params' || d.route === 'both')
      ? applyDeltas(params, d.paramDeltas)
      : params
    if (nextParams !== params) setParams(nextParams)

    const mid = say(d.reply || '好了。')
    setCards([])

    // 模型自己说"我不确定你说的是哪一个"时**不能动手**——
    // 一边问一边改是最糟的组合：用户还没回答，钱已经花了（一次约 12,900 tokens），
    // 而且改的可能是错的那个人。参数那半照常应用（免费可逆），只拦生成。
    //
    // 拦下来之后不是让用户把话说第二遍，而是**请他在图上点一下**（spec §6.3）：
    // 人多的时候"把后面那个人去掉"这种话再用词也说不清，位置说不清的地方
    // 指一下就清楚了。点完还要再确认一次 —— 那才是真正花钱的一步。
    //
    // 文案必须中性：模型会在**没有第二个人**的照片上说拿不准（记录里有它的原话
    // "后面好像只有山，没看到另一个人"），歧义也未必关于人（哪片天？哪块牌子？）。
    if (d.needsDisambiguation) {
      say('我不太确定你指的是哪个 —— 在图上点一下要改的地方？')
      // 记住他原来那句话：点了之后要连着标记一起再送，不能让他重说一遍。
      // 标记清空 —— 还没点。（pendingRef 为 null 只有"没人说过话就走到了这里"
      // 才会发生，今天走不到；空串和原来的 null 一样是"没有原话"，
      // canConfirmMark 照样不会亮。）
      setPending({ text: pendingRef.current ?? '', marker: null })
      return
    }

    // 送**当前的 base**（= image.bitmap），不是最初那张原图 —— spec §3.5。
    // ⚠️ `image` 必须进依赖数组：漏了它，这个回调会永远捕获第一次 render 的
    // image（null），生成再也不会被触发——而且是静默的：气泡照出、回复照有，
    // 照片纹丝不动，测试和 typecheck 却全绿。
    if ((d.route === 'generate' || d.route === 'both') && image) {
      await runGenerate(d.editPrompt, mid, nextParams, image.bitmap)
    }
  }, [params, say, runGenerate, image])

  /**
   * 拉建议卡片。
   *
   * **失败和超时都不影响任何主功能**，所以它自己不抛、只记日志：抛出去会被
   * `onPick` 的 catch 当成"这张图打不开"，而那根本不是事实。
   *
   * ⚠️ 回来时要过一道闸门：**底图还是原来那版吗**（`baseSeqRef`）。
   * 卡片是照着**上传那一刻那张照片**算的，而它要 11~15 秒才回来 —— 这十几秒里
   * 用户完全可能已经生成过一版（"把后面那些人去掉"），底图就换了。那时候
   * 这张卡还挂在屏上，点一下就是**花钱去改一件已经做完的事**（一次约
   * 12,900 tokens）。
   *
   * 判据是**底图变没变**，不是"用户开没开口"：参数类的话（"亮一点"）不换底图，
   * 卡片说的仍然成立，照旧该落地。`App.test.tsx` 里那两条一正一反钉着它俩
   * （「卡片落进点选流程」= 该落地的那半；「底图换过之后」= 该丢掉的那半）。
   *
   * ⚠️ **为什么只要一道闸门**：换照片也走 `baseSeqRef`（`onPick` 里那两行 `++`
   * 挨着写），所以"底图版本没变"**蕴含**"还是同一张照片"。原来这里还挂着
   * `pickIdRef`，它一次都没单独挡住过东西（两道计数器看着都得维护，实际一道是死的）。
   * `pickIdRef` 本身留着 —— 它另有用处：收那句"正在看…"提示（见 `onPick` 里的
   * `settle`）。**那道闸门换不得**：生成式编辑也会 +1 `baseSeq`，拿它当判据的话，
   * 等卡片期间改一版就会把"正在看…"永远挂在屏上。两件事，两个计数器。
   *
   * ⚠️ 「回到这一步」（`onJump`）换底图**故意不算**：它换回的是同一张照片的
   * 旧版本，卡片说的仍然成立；而且跳回原图之后，那批卡片恰好又是对的。
   */
  const loadCards = useCallback(async (img: DecodedImage) => {
    const baseSeq = baseSeqRef.current
    try {
      const preview = await prepareForRouting(img.bitmap)
      const s = await postSuggest({ imageDataUrl: preview.dataUrl })
      // 用原图而不是画布：此刻 params 还是全零，两者本就一样，
      // 直接用原图省掉一次"画布到底挂上了没"的竞态。
      if (baseSeqRef.current === baseSeq) setCards(s.cards)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const onPick = useCallback(async (file: File) => {
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
    } catch (e) {
      console.error(e)
      noticeBad('这张图打不开，换一张试试')
    } finally {
      setBusy(null)
    }
  }, [history, say, loadCards])

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
   * **把此刻画布上这张图导出来**：一个 blob + 一个文件名。
   *
   * ★ 抽出来只为**口径只有一份**。分享、下载、保存三条路的开头五句一字不差
   * （取两个 ref、挡一下没准备好、定格式和画质、拼文件名），分开写的话
   * `'image/jpeg', 0.95` 这个决定会散在三个地方 —— 哪天要加 PNG 选项或改画质，
   * 只改一处、另两处静默不一致，而**用户拿到手的会是两种质量**。
   *
   * 返回 null = 还没准备好（没画布或没文件）。调用方直接收工。
   */
  const exportCurrent = useCallback(async () => {
    const canvas = canvasElRef.current
    const file = originalFileRef.current
    if (!canvas || !file) return null
    return {
      blob: await buildExportBlob(canvas, file, 'image/jpeg', 0.95),
      name: buildFilename(file.name, 'image/jpeg'),
    }
  }, [])

  // 分享：画布尺寸就是当前 base 的尺寸。调色不缩图（spec §4.4）。
  //
  // 用户在真机上跑完 30 秒那条线后的原话：「下载后用户第一时间是不知道在哪里的」
  // —— 时间够了，但那一段让人心里没底。所以能分享的设备多给一个「分享」：
  // 点一下弹系统面板、一步选微信，跳过"翻文件管理器找图"。
  //
  // ⚠️ **这条路现在只做分享**（2026-09-25 / Task 13）。它以前还兼着
  // 「保存 = 老老实实下载」那一半，而 §3.4 把那一半搬走了：保存现在走 `onSave`
  // 存进作品集，不再偷偷下载。原来那个 `wantShare` 参数和它的早退分支
  // （`if (!wantShare || !canShare) downloadImage(...)`）**已经删掉** ——
  // 留着会让下一个读代码的人以为保存还会下载。
  // 下面 catch 里的"退回下载"**留着**：用户点的是"把图给我"，分享只是其中一种
  // 给法，失败不该让他两手空空（用户明确说过有时候就是不想分享）。
  const onShare = useCallback(async () => {
    if (!canvasElRef.current || !originalFileRef.current) return
    setDelivering('share')
    try {
      const out = await exportCurrent()
      if (!out) return
      try {
        await shareImage(out.blob, out.name)
      } catch (e) {
        // 分享真的失败了（没权限、系统拒绝）。退回下载，至少让他拿得到图。
        // 用户自己取消**不会**走到这儿 —— shareImage 把取消当成正常结束。
        console.error(e)
        downloadImage(out.blob, out.name)
      }
    } catch (e) {
      // 走到这儿只剩一种可能：`buildExportBlob` 自己失败了（图都没做出来），
      // 那时候也没有能退回下载的东西。
      console.error(e)
      noticeBad('分享失败，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [exportCurrent])

  // ── 「下载」= 桌面上把图拿到手的唯一一条路（2026-09-30 补）────────────
  //
  // ⚠️ **这个按钮存在的全部理由**：2026-09-29 的产品测试量出来，桌面上
  //    **没有任何一条路能把图拿到手** ——
  //      · 顶栏只有「调色 / 分享 / 保存」；
  //      · 「分享」只在 `canShare` 为真时渲染，而桌面 Chrome 的
  //        `navigator.share` 不认图片 → **那个按钮根本不出现**；
  //      · 「保存」只存进作品集；唯一的「下载到电脑」藏在**保存失败的横幅**里，
  //        也就是说，图**存成功了反而拿不到**。
  //    手机上那条路是通的（系统分享面板），所以这纯粹是桌面的缺口。
  //    修法就是把「分享」那一格在不能分享的设备上换成「下载」——
  //    **同一格位置，同一件事（把图给我）的两种给法**，不是多出一个按钮。
  //    （原来那格空着，理由是"不留一个点了没用的按钮"—— 那个理由对
  //    "点了没反应"成立，对"这是唯一一条拿图的路"不成立。）
  const onDownload = useCallback(async () => {
    if (!canvasElRef.current || !originalFileRef.current) return
    setDelivering('download')
    try {
      const out = await exportCurrent()
      if (out) downloadImage(out.blob, out.name)
    } catch (e) {
      // 走到这儿只剩一种可能：`buildExportBlob` 自己失败了（图都没做出来）。
      // 和分享那条**说同一句话** —— 用户看到的都是"把图给我"这一件事没成，
      // 分成两种说法只会让他以为出了两种毛病。
      console.error(e)
      noticeBad('图没能导出来，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [exportCurrent])

  // ── 「保存」= 存进作品集（Task 13，§3.4）──────────────────────────────
  // ⚠️ 这条路**一个字节都不下载**。下载挪到作品集里，由用户自己决定要哪张、
  //    存到哪 —— 设一个"默认开"的开关很别扭，因为**用户一开始根本不知道有
  //    那么个开关**；顺带也不再偷偷往他的下载文件夹堆东西。
  //
  //    代价是：**存不进去的时候，改好的图就只在屏幕上，一关页面就没了**。
  //    而那一刻他要的是"拿到图去发朋友圈"。所以下面那条失败路径上必须当场
  //    给一个「下载到电脑」—— §6.6 ①，§10 点名它「最容易漏」。

  /**
   * **此刻**这一份配方：参数 + 用户在屏幕上说过的原话。
   *
   * ★ 抽成一个函数只有一个理由：口径**只有一份**。`saveOnce` 平时现读它，
   * 而「上次那张要替换掉吗」那条路要在**问的那一刻**把它拍下来（终审 M4）——
   * 两处各写一遍的话，哪天口径变一处就会漏一处。
   *
   * ★ 原话 = 用户在屏幕上说过的那些话（裁定 ④）。
   *   `role: 'user'` 有**两个**来源，两个都该在这里：`send`（他敲进去的那句）
   *   和 `onCard`（**点建议卡片** —— 他点了「亮一点」，那就是他说了「亮一点」，
   *   把卡片标签记成用户消息是**对的**，不是 bug）。
   *   **不记 `editPrompt`** —— 那是给图片模型的英文 prompt，是我们的实现细节。
   */
  const recipeNow = useCallback((): Recipe => ({
    params,
    edits: messages.filter(m => m.role === 'user').map(m => m.text),
  }), [params, messages])

  /**
   * 存一次。`replaceId` 非 null = 替换掉那一张，null = 新存一张。
   *
   * ⚠️ **故意不收 `name`。** 文件名只对"下载到电脑"和失败时那句话有意义，
   *    存这一路用不上它 —— 服务端那份 `WorkInput` 只有 image / thumb / recipe，
   *    名字是详情页「改名」那条路管的（`renameWork`）。计划里那一版签名带着
   *    `name` 而从头到尾没读过它，`noUnusedParameters` 会当场红。
   *
   * ⚠️ `recipeAt` 传了就用它，没传才现读 `recipeNow()`（终审 M4）：
   *    「上次那张要替换掉吗」那条路隔着用户的一次回答，横幅挂着的时候他可能回头
   *    又改了一版。现读的话，存进去的是**旧图 + 新配方** —— 详情页会把这套调整
   *    当教学讲给他，而这套调整在这张图上从没发生过。
   */
  const saveOnce = useCallback(async (blob: Blob, replaceId: number | null, recipeAt?: Recipe) => {
    const canvas = canvasElRef.current
    // 缩略图是**顺手带的**：生成失败不该让整张图存不进去（裁定 ②）
    // ⚠️ 这一张要**显式传** `GALLERY_THUMB_MAX_SIDE`（480），不能用默认的 160：
    //    它下面是作品页那个**正方形**的格子（`aspect-ratio: 1/1; object-fit: cover`），
    //    吃的是缩略图的**短边**，而 `maxSide` 限制的是长边 —— 竖图 120×160 在
    //    181px 的格子里会被拉 1.51×（DPR 2 的屏上 3.02×）。算式在那个常量的注释里。
    //    （对话/撤销历史里那张仍旧用默认的 160，那一档是对的，别一起改。）
    let thumb: string | undefined
    try {
      if (canvas) thumb = makeThumbnail(canvas, GALLERY_THUMB_MAX_SIDE)
    } catch (e) {
      console.error('缩略图没做出来，这张作品将没有缩略图：', e)
    }
    const recipe = recipeAt ?? recipeNow()
    const body = { image: await blobToDataUrl(blob), thumb, recipe }
    if (replaceId !== null) {
      await replaceWork(replaceId, body)
    } else {
      const { id } = await createWork(body)
      setSavedId(id)
    }
    // 说一句"存好了"。**走通报条，不走对话**（2026-09-30 改）——
    // 理由不是"它不是对话"，是**对话栏有时候根本不在屏上**：手机上打开调色
    // 面板时 `.chat` 是 `display: none`（面板和对话在抢竖向空间），而那一刻
    // 正是用户拖完滑块按「保存」的时候。这句话原来落进一个用户看不见的地方，
    // 全链路回归在手机那趟抓到的（桌面全绿）。
    //
    // ⚠️ 也**绝不能**改成 `setMessages` 手写一条 `role: 'user'` ——
    // 那会当场变成"用户说过的原话"，混进上面那份配方里。
    setNotice({ text: '存好了，在左边「作品」里。', tone: 'ok' })
  }, [recipeNow])

  const onSave = useCallback(async () => {
    if (!canvasElRef.current || !originalFileRef.current) return
    setDelivering('save')
    setSaveFail(null)
    // ⚠️ 声明在 try 外面、留着 null：它同时是"图做出来了没有"的标记，
    //    catch 里要靠它决定能不能给用户一个「下载到电脑」（§6.6 ①）。
    let out: { blob: Blob; name: string } | null = null
    try {
      out = await exportCurrent()
      if (!out) return
      if (savedId !== null) {
        // 同一张照片改过好几遍了 —— 问一句。不问的话改了 5 遍就是 5 张
        // 几乎一样的图，作品集立刻没法看（§3.4）。
        // ⚠️ **顺手把配方一起拍下来**（终审 M4）：他回答之前可能又改了一版，
        //    那时候现读的就是"新那套配旧那张图"。
        setAsking({ blob: out.blob, name: out.name, recipe: recipeNow() })
        return
      }
      await saveOnce(out.blob, null)
    } catch (e) {
      console.error(e)
      // ★★ §6.6 ①：那一刻他的目的是"拿到图去发朋友圈"。存不进去是**我们这边的
      //    限制**，不该让他连图都拿不到。所以把 blob 留下来，界面上出现一个
      //    能下载的按钮。`blob` 还是 null 就是**另一种失败**（图都没做出来），
      //    那种情况下没有东西可以给，说的话也不一样 —— 见下面那段。
      //    （`out` 为 null 时那个 `name` 永远不会被读到：没图就没有下载按钮。）
      setSaveFail({
        blob: out?.blob ?? null, name: out?.name ?? '',
        why: e instanceof Error ? e.message : '没存进去',
      })
    } finally {
      setDelivering(null)
    }
  }, [savedId, saveOnce, recipeNow, exportCurrent])

  /** 回答「上次那张要替换掉吗」：`replaceId` 非 null = 替换，null = 再存一张。
   *  两条回答走**同一段代码**，只有那一个参数不同 —— 分开写两份的话，
   *  「存失败怎么办」那一半迟早只在其中一份里改。
   *
   *  ⚠️ 配方用的是 `asking` 里**拍下来的那一份**（终审 M4），不是现读：
   *  问的是"上次那张要替换掉吗"，那就得配着那张图当时的调整一起存。 */
  const answerAsk = useCallback((replaceId: number | null) => {
    const cur = asking
    if (!cur) return
    setAsking(null)
    setDelivering('save')
    void saveOnce(cur.blob, replaceId, cur.recipe)
      .catch((e) => setSaveFail({
        blob: cur.blob, name: cur.name,
        why: e instanceof Error ? e.message : '没存进去',
      }))
      .finally(() => setDelivering(null))
  }, [asking, saveOnce])

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
    const p = pathOf(v)
    if (location.pathname !== p) {
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
   */
  useEffect(() => {
    if (!checking && user && view.kind === 'landing') go({ kind: 'edit' }, { replace: true })
  }, [checking, user, view, go])

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
                  <button className="primary" onClick={() => onShare()} disabled={delivering !== null}>
                    {delivering === 'share' ? '准备中…' : '分享'}
                  </button>
                ) : (
                  <button className="primary" onClick={onDownload} disabled={delivering !== null}>
                    {delivering === 'download' ? '准备中…' : '下载'}
                  </button>
                )}
                {/* 「保存」= 存进作品集（§3.4）—— 它不再下载，所以走的是 `onSave`。 */}
                <button onClick={onSave} disabled={delivering !== null}>
                  {delivering === 'save' ? '准备中…' : '保存'}
                </button>
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
                · 有两条测试按结构钉着 `.actions button` 恰好是那三颗
                  （见 App.test.tsx 的 topbarButtons），混进去等于改了一个没人
                  说要改的界面。
                放**最后一个**子节点是为了让它钉住右上角：`.topbar` 是
                space-between，第三个孩子会被排到正中间去。 */}
            <button className="user-btn" onClick={() => go({ kind: 'account' })}
                    aria-label="用户管理">👤</button>
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
                <button
                  className="download"
                  // ⚠️ 这个 `!` 是**结构上**安全的，不是"我保证"：它上面那行
                  //    `{saveFail.blob &&` 已经把 false 那一支挡掉了，能渲染到这里
                  //    就说明 blob 非 null。（而且不能把 `&&` 换成 `?.` —— `&&`
                  //    也是"按钮出不出现"本身：没图就不该有这个按钮。）
                  //    **别照着这里在别处也随手加 `!`**：换个地方它可能真的会是 null。
                  onClick={() => downloadImage(saveFail.blob!, saveFail.name)}
                >
                  下载到电脑
                </button>
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
            />
          )}
        </div>
      )}

      {/* 作品页（Task 11）：按天分组、先摆 60 张、名字就是时间所以搜日期也能搜到。
          `onOpen` 只把 id 交出去 —— 拼网址那条规则仍然只有一份（ui/view.ts），
          组件自己不认识"网址"这回事。 */}
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
