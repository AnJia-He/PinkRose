import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustEmpty from './ui/AdjustEmpty'
import AdjustmentPanel from './ui/AdjustmentPanel'
import PresetRail from './ui/PresetRail'
import TopActions from './ui/TopActions'
import Banners from './ui/Banners'
import CropControls from './ui/CropControls'
import RetouchControls from './ui/RetouchControls'
import ChatPanel, { type ChatMessage } from './ui/ChatPanel'
import StepStrip from './ui/StepStrip'
import StepNav from './ui/StepNav'
import ToolBar, { type ToolId } from './ui/ToolBar'
import { LoginPage } from './ui/LoginPage'
import { GalleryPage } from './ui/GalleryPage'
import { SessionsPage } from './ui/SessionsPage'
import { WorkDetailPage } from './ui/WorkDetailPage'
import { AccountPage } from './ui/AccountPage'
import { ModelSettings } from './ui/ModelSettings'
import { LutSettings } from './ui/LutSettings'
import LandingPage from './ui/LandingPage'
import { Nav } from './ui/Nav'
import { me, type AccountUser } from './api/account'
import { fetchWorkImage } from './api/works'
import {
  createSession, sessionOriginalUrl, updateSession,
} from './api/sessions'
// ★ 2026-10-10（「我的预设」）：清单在 `app/usePresets`，存/改名/删三个动词在这儿。
import { createPreset, deletePreset, renamePreset } from './api/presets'
// ★ 2026-10-09：对话栏顶上那个名字的**唯一**口径（三级退：用户起的名字 →
//   照片上传时的名字 → 「还没说话」）—— 和对话列表同一份，别在这儿另退一套。
import { sessionTitle } from '../shared/sessions.ts'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { resizeBitmap } from './image/resize'
import { samplePixels } from './image/sample'
import { matchToReference } from './core/colorMatch'
import { activePresetId } from './core/presets'
import { fitToLimit, probeLimit } from './render/limits'
// ★ 2026-10-08（账本 Task 8）：恢复会话时那条**离屏重画**的临时管线（全站第三处
//   `new TonePipeline`，规模刻意压在"一条管线 + 一张画布、用完 dispose"）——
//   ★ 2026-10-08（拆分 Batch 6）：它跟着 `loadSession` 一起搬进
//   `app/useLoadSession`（这个文件里另两处 `TonePipeline` 的引用都是注释）。
import { applyDeltas, ZERO, type Adjustments } from '../shared/adjustments.ts'
import { canShareImage } from './export/save'
import { prepareForRouting } from './image/prepare'
import { errorText, isUnauthorized, postRoute } from './api/client'
import { bitmapsToClose, attachThumb, closeBitmaps, type Snapshot } from './core/history'
// ★ 2026-10-08（调色区账本）：裁剪/点修不再推新快照 —— 它们给「当前这一版」
//   记一笔账（`pushEdit` 把"改之前"压进 `past`），退这一步走账本的 `undoEdit`。
//   `flushEdit`（调色那一笔的定稿）用 `sameEdit` 判净零、用 `pushEdit` 记账；
//   调色屏左下角那组箭头（`ledgerStep`）走 `undoEdit` / `redoEdit`，
//   画几笔看 `ledgerTotal`。
//   ★ Task 5：**记账统一收口**——四处记账点记完都过一遍 `settleLedger`
//   （预算闸 `enforceLedgerBudget` + 位图回收）。★ 2026-10-08：`settleLedger`
//   和 `closeBitmaps` 一起搬进了 `core`（`app/baseEdit.ts` 那份共享骨架要用）。
import {
  ledgerIndex, ledgerTotal, pushEdit, redoEdit, sameEdit, settleLedger, undoEdit, type EditState,
} from './core/ledger'
// ★ 2026-10-08：删除的单位是"一问一答"（用户报的"删了一条、另半条还留着"），
//   `expandDeleteIds` 就在这儿把一条 id 补成整轮 —— 纯函数，和 ChatPanel 勾选
//   那侧共用同一份（别在两处各写一遍配对逻辑）。
import { expandDeleteIds } from './core/messages'
import {
  GALLERY_THUMB_MAX_SIDE, ORIGINAL_PREVIEW_MAX_SIDE, bitmapToDataUrl, makeThumbnail,
} from './core/thumbnail'
import { markImage, type NormPoint } from './image/mark'
import { useDelivery } from './app/useDelivery'
import { BUSY_GENERATING, useGeneration } from './app/useGeneration'
import { useLuts } from './app/useLuts'
// ★ 2026-10-10（「我的预设」）：自己的预设清单 —— `usePresets` 就是"清单那一半"
//   （照 `useLuts` 的对应件；存/改/删三个动作在下面那三个回调里）。
import { usePresets } from './app/usePresets'
// ★ 2026-10-08（拆分 Batch 3）：三个小簇各自的 hook —— 通报 / 导航 / 滤镜流程。
import { useNotice } from './app/useNotice'
import { useNav } from './app/useNav'
import { useLutFlow } from './app/useLutFlow'
import { usePersist } from './app/usePersist'
import { useCrop } from './app/useCrop'
import { useRetouch } from './app/useRetouch'
import { useLoadSession } from './app/useLoadSession'
// ★ 2026-10-10：拖/粘一张照片进来 = 换一张改（见 hook 里的注释）。
import { usePhotoDrop } from './app/usePhotoDrop'
import { sameLutName, type LutRef } from '../shared/lut.ts'
import type { SuggestCard } from '../shared/protocol.ts'
import type { WorkMeta } from '../shared/works.ts'

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

// （「按住看原图」那张预览的边长上限 ★ 2026-10-08 搬进 `core/thumbnail` 了 ——
//   这个文件和恢复会话的 hook 两处都要用。）

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

// ── 点修（★ 2026-10-07，工具行第二颗）────────────────────────────────────
//  ★ 2026-10-08：这一簇整段搬进 `app/useCrop` / `app/useRetouch`（含
//  `defaultCropRect` 与 `MAX_ERASE_PIXELS` / `ERASE_VEIL_PIXELS` 两个常量），
//  文件头上"这一层只管什么"那段也跟着走了。

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
type PendingMark = {
  text: string
  marker: NormPoint | null
  /**
   * ★ 2026-10-05：**本条指令的第一条消息**（send / 卡片插进去的那条用户消息）。
   * 切口切对话时"从它起保留"（设计 §4.3）—— 不带着它，点选那条路
   * （点「就改这里」才生成）就没有"现在"和"过去"的分界，会把用户刚说的话切掉。
   */
  keepFrom: number
}

/**
 * ★ 2026-10-05（设计 §4.5）：从**旧步骤**继续改之前那条确认。
 *
 * `keepFromMsg` 缺席 = "确认那一刻才知道"：「再来一版」那条路没有新的用户消息，
 * 切对话的保留边界就是**确认那一刻 `nextId()` 发出的那个号**（`confirmReplace`
 * 里的 `mid`）—— 它同时是这一步的步骤 id 和那句 reply 的消息 id（先发号、
 * 再交给 `runGenerate`，见那边的注释）。
 * （措辞 2026-10-06 更正：原来写的是"确认之后 `say(reply)` 拿到的那个 id"——
 *  机制早就不是 `say` 了，那句话现在由 `runGenerate` 在成功那一刻插；语义没变。）
 */
type PendingReplace = {
  stepId: number
  editPrompt: string
  reply: string
  keepFromMsg?: number
}

export default function App() {
  /** 当前登录的人。null = 没登录（或者还在问后端）。 */
  const [user, setUser] = useState<AccountUser | null>(null)
  /** 开机那一次"我是谁"问完了没有。
   *  它和 `user` 是**两件事**：`user === null` 既可能是"没登录"、也可能是
   *  "还没问出来"，不分开的话每个还没登录的人都会先看到登录页闪一下。 */
  const [checking, setChecking] = useState(true)

  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  /** ★ 2026-10-06（工具行）：调色屏当前开着哪个工具。null = 都没开。 */
  const [tool, setTool] = useState<ToolId | null>(null)

  /**
   * 顶上那条**通报**（有件事要说一声，说完可以收走）—— ★ 2026-10-08 整段搬进
   * `app/useNotice`（它取代了三处 `window.alert`、"它和 `saveFail` 是两种东西、
   * 别合并"那几条理由，都在那个文件头上）。
   *
   * ⚠️ 它必须声明在**这个位置**：`useLuts` 要接 `noticeBad`（"滤镜没取回来"
   *   那一句），而**参数在调用点必须已经声明**（`const` 是 TDZ：写在后面就是
   *   运行时报错）。
   */
  const { notice, setNotice, noticeBad, noticeOk } = useNotice()

  /**
   * ★ 2026-10-05（滤镜）：这张照片现在用着哪个滤镜、强度多少。null = 不用。
   *
   * ⚠️ 它**不进 `params`** —— 那是个"十五个数字"的 record，被 toUnit / 范围表 /
   * 提示词 / 照调那几处当数字消费（设计 §3.2）。它和 `params` 是**并列的两件事**，
   * 但走的是同一条路：拖强度 / 套滤镜**都不推快照**（裁定 ⑤），只落盘。
   */
  const [lut, setLut] = useState<LutRef | null>(null)
  /**
   * ★ 2026-10-05：「下一趟进调色屏时，把面板里「滤镜」那一栏**展开**」。
   *
   * 唯一的来源是「滤镜」那一页那颗「去调色里套一张」（用户：「我没看到怎么去
   * 调用 lut 文件」）—— 用 ref 而不是 state：它是**一件只发生一次的事**（面板挂载
   * 那一刻读一下初值），不是"这个界面现在长什么样"。放进 state 会多一次没必要的
   * 重渲染，而且"用完了要记得清"那件事在 state 上更容易忘。
   *
   * ⚠️ 清掉它那条 effect 在**下面**（`view` 声明之后）—— 写在这儿会踩 TDZ
   *    （`Cannot access 'view' before initialization`，整个 App 当场白屏）。
   */
  const lutOpenNext = useRef(false)
  /**
   * 滤镜那一摊（清单 / 当前的 cube / 缩略图，见 `app/useLuts`）。
   *
   * ⚠️ 它挂在**组件顶上**、每一次渲染都调：这是一个 hook，不许被条件包起来。
   * 它不碰画布、不碰 history —— 只认"清单 + 当前这个 id + 当前这张照片"。
   *
   * ★ 2026-10-05 终审修复：`onError` 接的是 `noticeBad` —— 滤镜文件取不回来时
   *   **说一句**（原来是吞成一行 console：格子亮着、画面不变、一句话都没有）。
   *   `noticeBad` 的身份是稳定的（`useCallback([])`），正合这个 hook 的要求。
   */
  const lutsApi = useLuts({ lut, image, params, onError: noticeBad })
  /**
   * ★ 2026-10-10（「我的预设」，设计 §5.1）：自己的预设清单 —— `usePresets` 就是
   *   那"清单那一半"（同样的 `known` 语义：到手 ≠ 非空）。存 / 改名 / 删三个动作
   *   在下面那三个回调里，成功之后都是**重拉**（名单的真值只有服务端那一份）。
   */
  const presetsApi = usePresets()
  /**
   * 单拎出来一个 `reload`（★ 2026-10-05）—— `lutsApi` 是每次渲染新造的**对象**，
   * 拿它当依赖的话，挂在 `refreshLuts` 上那个 effect 每次渲染都要重跑一遍
   * （今天有守卫、不会出事，但那是"碰巧没事"）。`reload` 自己是 `useCallback([])`
   * 的，身份稳定。**别把这个解构挪进 `refreshLuts` 的依赖数组里写 `lutsApi`。**
   */
  const reloadLuts = lutsApi.reload
  /** 非 null 时既是"正在忙"的标志，也是要显示给用户的那句话 */
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * ★ 2026-10-06（用户原话：「而且中途思考要有一些加载动作比如正在思考，要让用户
   * 知道你在干嘛」）：**这一趟是不是真的在生成**。
   *
   * 它决定两处"看得见"：对话里图的位置摆不摆占位块、照片上盖不盖那层暗罩。
   * 「正在思考…」（决策那段 1.3~1.6 秒）和上传/切会话那几句**都不算** ——
   * 一闪一暗会闪。
   *
   * ⚠️ 判据是**那个常量本身**（`useGeneration` 导出的 `BUSY_GENERATING`），
   *   不是字符串嗅探（`busy.startsWith('正在改')` 那种：文案改一个字就静默失效）。
   */
  const generating = busy === BUSY_GENERATING
  /** 本设备能不能把图交给系统分享面板。只在挂载时算一次：设备能力不会中途变。
   *  用惰性初始化（传函数），免得每次 render 都去 new 一个探针 File。 */
  const [canShare] = useState(canShareImage)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cards, setCards] = useState<SuggestCard[]>([])
  /** ★ 2026-10-03：用户**在欢迎页那条对话输入框里先打的字**。
   *  它不是"待发送"的队列，只是一份**一次性的草稿**：选照片时由 `onPick` 接住，
   *  交给 `ChatPanel` 填进输入框（`draft`），用户自己按发送。
   *  ⚠️ 故意**不自动发**：自动发要和"照片解码完 / 画布挂上 / 建议卡还在路上"
   *  这几件事排队，稍微错一点就是"话发出去了、照片还没准备好"的静默失败。
   *  填进输入框只差用户按一下，而按一下是看得见的。 */
  const [draft, setDraft] = useState('')
  /** 正在等建议卡片。**它不拦任何人** —— 发送键照常能按、话照常能说，
   *  它只负责在卡片那一格上挂一句"正在看这张照片能改什么…"。
   *  （`busy` 是"现在什么都做不了"，这个不是。两件事，别合并。） */
  const [suggesting, setSuggesting] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  /** 「按住看原图」用的预览图（data URL）。没照片时是 null。 */
  const [originalPreview, setOriginalPreview] = useState<string | null>(null)
  /** 图上点选那一整条流程的状态（见 PendingMark）。null = 没在等用户点。 */
  const [pending, setPending] = useState<PendingMark | null>(null)

  /**
   * ★ 2026-10-05：**现在站在哪一步**（步骤 id = 那条助手消息的 id，老约定）。
   *
   * 「回到这一步」只动它、不再截断 history（设计 §3）—— 被跳过的步骤留在
   * history 里，图/按钮都还在，随时能再点回去。
   *
   * 不变量：有照片 ⇒ history 非空 ⇒ 它不是 null 且指向 history 里真存在的一步。
   * 赋值点**全表**（少一处就是"你在这里"标错地方 / 切口切错位置，两种都不报错）：
   *   · 上传建原图那一步 → welcomeId（`onPick`）
   *   · 一次生成成功推入新步 → messageId（`useGeneration` 的 `runGenerate`）
   *   · 跳转 → 目标 id（`onJump`）
   *   · 恢复会话 → 最后一步 id（`loadSession`）
   *   · 归零（换照片 / 删会话 / 新的一张）→ null（`resetEditor`）
   *
   * ⚠️ 必须是 useState 不能是 ref：它喂给「你在这里」和两条确认条，ref 变了
   *   不重渲染（`sessionId` 当初踩过同一个坑）。
   */
  const [cursorId, setCursorId] = useState<number | null>(null)
  /**
   * ★ 2026-10-05（终审 I1）：`cursorId` 的**同步影子** —— 给"隔了 await 才读到它"的地方用。
   *
   * `send` 从发出到 `applyDecision` 中间隔着两段 await（1.3~1.6 秒），而
   * 「回到这一步」有意**没有 busy 闸门**：这段窗口里用户一跳，`applyDecision`
   * 闭包里的 `cursorId` 就已经是旧的了 —— 确认条的 N 用**新**位置算、切口用
   * **旧**位置执行，那条提示会说假话（跳回最新一步后甚至出现"后面还有 0 步"），
   * 点下去切的地方也不是它说的那处。
   * 写状态的地方**同时**写这个 ref，读的地方（`applyDecision`）读 ref.current。
   * ⚠️ 它**不是** state 的替代（上面那条"必须是 useState"照旧成立，渲染读的还是
   *   state）—— 它只服务"隔了 await 才读"的那一处，和 `sessionIdRef` 是同一个路数。
   * ⚠️ `runGenerate` 的 `origin` 仍然走**显式入参**，不受这里影响 ——
   *   「再来一版」是"先跳转、再同一个 tick 里调用"，读 ref 也一样会拿到旧值吗？
   *   不会（ref 是同步写的）—— 但那条路继续用显式入参，是它自己那条理由。
   */
  const cursorIdRef = useRef<number | null>(null)
  /** 移动"站的位置"：state 和影子 ref **必须一起写**（理由见 `cursorIdRef`）。 */
  const moveCursor = useCallback((id: number | null) => {
    cursorIdRef.current = id
    setCursorId(id)
  }, [])

  /**
   * 把画面 / 参数 / 滤镜**一起**还原成某一步的样子（★ 2026-10-08 收口）。
   *
   * 三样**必须一起**（原来在 `onJump` / 删记录 / 翻账本三处各写了一遍）：
   *   · 只还原 base 会让画面和滑块对不上 —— 用户看到的和面板里显示的是两回事；
   *   · ★ 2026-10-05（滤镜，审查 Important-2）：**滤镜也得跟着回**，和参数**对称**。
   *     `Snapshot.lut` 是**按步**记的，不做的话用户看得见两处：
   *       · 每一步的小图是从**带滤镜的画面**上抓的（`makeThumbnail(canvas)`）——
   *         跳回去之后主画面和那条气泡上的小图对不上；
   *       · 「原图」那一步永远是 `lut: null`，而「回到原图」却留着那层颜色 ——
   *         那已经不是原图了。
   * ⚠️ 它**不动"站的位置"**（`moveCursor`）—— 跳转是"挪光标 + 还原画面"两件事，
   *   翻账本（`ledgerStep`）只要后者。
   */
  const applySnapshot = useCallback((s: Snapshot) => {
    setImage(s.base)
    setParams(s.params)
    setLut(s.lut)
  }, [])

  /** 从旧步骤继续改之前那条确认（`PendingReplace`，见它的定义）。null = 没在问。 */
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null)

  // 下面四样**从 `pending` 推出来**，不再各自是一个 state —— 推出来的东西不可能
  // 互相不同步，这正是折成一个对象的意义。名字保留，读代码时不必重新认路。
  const picking = pending !== null
  const marker = pending?.marker ?? null
  const pendingText = pending?.text ?? null
  const pendingKeepFrom = pending?.keepFrom ?? null   // ★ 见 PendingMark

  /**
   * **换底图 / 换照片那几处都要清的那一批"上一条照片的临时状态"**（★ 2026-10-08 收口）。
   *
   * 两条后果各有一半是"错了不报错"（终审 I3 抓过一条，两处各漏过一半）：
   *   · 点选那半：红圈存的是**旧底图**的归一化坐标（还在屏上、还能点
   *     「就改这里」）—— 那是**花钱**的一次生成，改的位置是错的；
   *   · 确认条那半：挂着"要切掉后面吗"时裁一刀 / 切会话，回修图屏点「继续改」，
   *     它的切点还落在原图上，会把**后面那一版**切掉（条子自己还会改口说
   *     "后面还有 0 步"）；切会话那条更直白 —— 它会停在**别人那条**会话上。
   * 原来这一对零散写在五个调用点（`onPick` / `loadSession` / `resetEditor` /
   * 裁剪 / 点修）—— 收成一处，漏一处就是上面那两种静默事故。
   */
  const clearTransient = useCallback(() => {
    setPending(null)
    setPendingReplace(null)
  }, [])

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
   * 上一条那个待办记号销在**新会话**头上 —— 见落盘里销账那一句）。
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

  /**
   * ★ 2026-10-09（用户原话：「这一块设计像豆包一样显示当前会话名称」）：
   * **这条会话叫什么** —— 对话栏顶上那一行要显示的东西。
   *
   * 存的是 `SessionMeta` 那两格（`title` / `originalName`），不是算好的字符串：
   * 名字是**三级退**出来的（用户起的名字 → 照片上传时的名字 → 「还没说话」），
   * 而"退到第几级"这件事只有 `sessionTitle()` 那一份口径
   * （`shared/sessions.ts`，对话列表同一份）—— 这里再退一次就是第二个口径。
   *
   * 三个写入点，一条都不能少（漏一个就是"屏幕上写着上一个名字"）：
   *   · `onPick` —— 上传那一刻，先用**文件名**顶着（会话 id 还没回来，
   *     但名字当场就有，用户看不到一行空白）；
   *   · `useLoadSession` —— 接回 / 点开一条旧会话时照服务端那份铺上；
   *   · 改名成功之后 —— 只换 `title` 那一格（见 `renameSession`）。
   * 清空它的地方只有 `resetEditor`（"把手上这一张整个放下"）。
   */
  const [sessionName, setSessionName] = useState<
    { title: string | null; originalName: string | null } | null>(null)

  /**
   * 顶上那颗铅笔提交的新名字。空串 = 清空（服务端存成 `null`，显示退回照片名）。
   *
   * ⚠️ **没改名就什么都不发**：比的是**显示名**，不是 `title` 字段 —— 比字段的话，
   *   一条"还没起过名"的会话（`title` = null、显示的是照片名）会被这趟"没改的改名"
   *   **静默实化**（库里凭空多出一个等于照片名的 title）。这条账和对话列表那颗
   *   「改名」是同一份（`SessionsPage.doRename`），两边别各写各的。
   * ⚠️ 提交的只有 `{title}` 这一个字段 —— 服务端凭这个判据**不动 `updated_at`**
   *   （改名字是整理，不该让这条会话在列表里跳到"今天"，见 `server/sessions.ts`
   *   的 `titleOnly`）。往 patch 里塞别的东西就会把它顶掉。
   * ⚠️ 失败**不许静默**：屏幕上原样，上面挂一句（照 `SessionsPage` 那条）。
   */
  const renameSession = useCallback(async (next: string) => {
    const id = sessionIdRef.current
    if (id === null) return
    const name = next.trim()
    if (sessionName && name === sessionTitle(sessionName)) return
    try {
      const meta = await updateSession(id, { title: name })
      // ⚠️ **只换 `title` 那一格**，不拿回来的整份 meta 顶掉本地那份：
      //   `originalName` 是上传时那个文件名，改名这一趟服务端不会动它，
      //   而"回什么存什么"在这里会把显示名的退路一起换掉。`title` 用服务端
      //   回来的那个（它做过 trim 和长度截断，60 字的上限在输入框上）。
      setSessionName(n => (n ? { ...n, title: meta.title } : n))
    } catch (e) {
      noticeBad(errorText(e, '没改成，再试一次'))
    }
  }, [sessionName, noticeBad])

  /**
   * ★ 2026-10-08（调色区账本 Task 7，spec §7.2）：**哪一版的"现在"变了** ——
   * 落盘按它决定这一趟"存谁"、要不要连底图一起重传。
   *
   * 两个字段就两件事：`stepId` = 这一趟的 `stateStepId`（状态挂在**那一版**上，
   * 不是含糊的"最后一步"）；`baseChanged` = 那一版**换了底图**（裁剪 / 点修 /
   * 翻账本退到换过像素的一笔 / 新版本出生 / 删掉 tip —— 这些才要重传像素，
   * 拖滑块不要）。`null` = 没有待办的账。
   *
   * ⚠️ **合并语义：同一步的 `baseChanged` 只增不减**（`markDirty` 里那句 `||`）。
   *   先裁了一刀还没发出去、紧接着又拖了滑块 —— 后一笔标 `false`（调色不换底图），
   *   要是把它当"新的一笔"覆盖掉，那一刀就**永远送不出去**了（屏幕上照变，
   *   刷新回到没裁的样子，一句错都不报）。
   * ⚠️ **成功写回之后才清**（在落盘那个 `run` 的应答里）—— 先清的话，一次失败
   *   会把那一版永久跳过（后面再也不会重送它）。失败时留着，下一次改动会自动
   *   再送一遍（屏幕上那句"接着改会自动补上"说的就是它）。
   * ⚠️ 它**不触发重渲染**（ref）—— 所以每次 `markDirty` 都必须是"同一批里还有
   *   别的 setState"的那些时刻（记账 / 裁剪 / 生成落地 / 镜像），落盘那个 effect
   *   才会跟着重跑、重排那个 800ms 的闹钟。今天每一个调用点都满足（见各处注释）。
   * ⚠️ 它**在换照片 / 换会话 / 归零三处被清成 null**（和 `editPendingRef` 同一批）。
   * ⚠️ **只有一格**（同时只记一版，改完 A 再改 B 就是 B 覆盖 A）。今天这够用：
   *   所有"改到另一版去"的路（`onJump` / 切会话 / 换照片）都**先 flush** 把 A 那趟
   *   发出去。**已知边界**：A 那趟**失败**了、人又跑到 B 上动手 —— A 的底图这一轮
   *   不会再自己送（要等 A 下一次被改动；`messages` / `steps` 照旧每趟都送）。
   *   要补的话得把这一格换成"按版本排队"，那是另一件事（设计只要求一格）。
   *
   * ⚠️ 为什么这对声明摆在**这一簇的最上面**（离"会话"比离"落盘"近）：读它的
   *   `useCallback` 有好几只，其中 `dropGoneLut` / `refreshLuts` 在文件里出现得
   *   比落盘那一大段**早得多** —— 晚一步声明，光是把 `markDirty` 写进它们的
   *   依赖数组就是 TDZ、整个 App 白屏（这个文件为这件事写过好几处注释：
   *   "摆在 send 前面…落在后面就是 TDZ"）。声明在这儿，所有调用点都能照
   *   "读到的就写进依赖"那条规矩老实写。
   */
  const dirtyRef = useRef<{ stepId: number; baseChanged: boolean } | null>(null)
  /**
   * 记一笔"这一版的现在变了"。**一步一行**，调用点就那几处（写回 effect /
   * `commitCrop` / `commitRetouch` / `ledgerStep` / 生成落地 / 删 tip /
   * 删滤镜时扫到的那一版）。
   */
  const markDirty = useCallback((stepId: number, baseChanged: boolean) => {
    const prev = dirtyRef.current
    dirtyRef.current = {
      stepId,
      // 同一步的 `baseChanged` 只增不减（理由见 `dirtyRef` 那段 ⚠️）。
      baseChanged: baseChanged || (prev?.stepId === stepId ? prev.baseChanged : false),
    }
  }, [])

  // ★ 2026-10-08：`dropGoneLut` / `refreshLuts` / `needLutThumbs` 三个函数
  //   整段搬进了 `app/useLutFlow`（连同它们上面那几大段理由与 ⚠️）。
  //   ⚠️ 调用点在**下面** `editPendingRef` 之后 —— 那边要拿"没定稿的那一笔"。

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
      // ★ 2026-10-05（T12）：配方里那一行 —— 滤镜只存**名字**，所以清单也要给它
      //   （id → 名字的转换在 `recipeNow` 里现做）。
      lut, luts: lutsApi.luts,
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
  /**
   * **账本发号器**（★ 2026-10-08，调色区账本）：账本里每一笔的入账序号 ——
   * 全局单调，预算驱逐（`enforceLedgerBudget`）按它挑"最老的那一笔"丢。
   *
   * ⚠️ 和 `idRef` **是两本账**，别合并：那个发的是消息 / 版本 id（"消息 id 就是
   *   步骤 id"那条老约定靠它对齐），这个只给账本排先后 —— 裁剪/点修现在
   *   **不产生新版本**、只登记一笔账，拿 `idRef` 顶会让版本 id 凭空跳号。
   *   （`editPendingRef` / `flushEdit` 是它的另一半：那边管"没定稿的一笔"，
   *   号也从这儿发 —— 见顶上那段。）
   */
  const editSeqRef = useRef(0)
  /**
   * **没定稿的那一笔**（★ 2026-10-08，调色区账本 Task 4）：一次**连续**调色的
   * "**改之前**"从这儿起 —— 停手约 0.8 秒、或者撞上任何一个定稿点（点箭头 /
   * 落刀裁剪 / 生成落地 / 切会话），它才真的记进账本（`flushEdit`）。
   *
   * `stepId` = 这一笔挂在**哪一版**上：现场改动写回的是"当前这一版"，所以站在
   * 旧版本上拖滑块，记的也是旧版本的账。
   *
   * 「改之前」为什么要把 `before` 整份拍下来（而不是只记一个"起点号"）：
   * 账本上的一笔必须是**两个完整画面状态**（`pushEdit` 的入参形状）——
   * 中间那几次拖动不留痕，用户看到的只有一头一尾。
   */
  const editPendingRef = useRef<{ stepId: number; before: EditState } | null>(null)

  /**
   * 滤镜那一摊里**跟着 App 状态走**的那半 —— ★ 2026-10-08 整段搬进
   * `app/useLutFlow`：`dropGoneLut`（当前用的滤镜没了）/ `refreshLuts`（离开
   * `/app/luts` 时重拉 + 照镜子）/ `needLutThumbs`（打开那一栏那一刻），
   * 加上 `refreshLuts` 照镜子用的那个 `lutRef` 影子 —— 各条理由都在那边。
   *
   * ⚠️ 调用点必须在**这里**（`editPendingRef` 之后）：`dropGoneLut` 要连
   *   "没定稿的那一笔"一起扫，那本账在上面这一行才立起来。
   */
  const { refreshLuts, needLutThumbs } = useLutFlow({
    lut, setLut, lutsApi, image, params, noticeBad,
    cursorIdRef, editPendingRef, setHistory, markDirty,
  })

  /**
   * **落盘那一整簇** —— ★ 2026-10-08 整段搬进 `app/usePersist`：调色那一笔的
   * 定稿（`flushEdit`）、800ms 防抖把"现在这一趟"存回服务端、以及"页面要走了"
   * 两条 keepalive 的路（`flushPersist`）—— 连同 effect 尾巴上那六条依赖各自的
   * 一段历史（"别删"那几句）。
   *
   * ⚠️ 调用点必须在**这里**：`flushEdit` 要那个"没定稿的一笔"（`editPendingRef`）、
   *   落盘 effect 要 `dirtyRef` 与 `canvasElRef` —— 都在上面几行才立起来。
   * ⚠️ `pendingPersistRef` 从这里回给 App（`onSessionDeleted` 要亲手摘掉那一趟）。
   */
  const { flushEdit, flushPersist, pendingPersistRef } = usePersist({
    history, messages, params, lut, sessionId, sessionIdRef, cursorId,
    dirtyRef, editPendingRef, editSeqRef, setHistory, canvasEl: canvasElRef, noticeBad,
  })

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
   * 对比用的原图（★ 2026-10-06）：第一次点「对比」才做（懒做），长边 ≤ 2048。
   * ⚠️ 不许拿 `originalPreview`（那是 480 的缩略图）：分屏是**并排比**，
   *   左边糊右边清楚，用户会以为是我们把照片弄糊了。
   * 备好之后留在内存里（同一条会话里反复进出对比不用再编一遍）；
   * 换照片 / 换会话时跟着清（那三处）。
   * ★ 2026-10-08（拆分 Batch 6）：声明挪到这一头 —— **恢复会话的 hook 要清它**
   *   （切会话换了一张照片，备着的还是上一条会话那张原图）。
   */
  const [compareSrc, setCompareSrc] = useState<string | null>(null)

  /**
   * 恢复会话那一整簇 —— ★ 2026-10-08 整段搬进 `app/useLoadSession`：
   * `loadSession`（把服务端上的一条会话铺回整个 App）+ 挂载时那次"接回上次那条"
   * + 只服务它的三个 ref（`mountedRef` / `loadSeqRef` / `restoreTriedRef`）。
   *
   * ⚠️ 那里面住着三条"错了不报错"的老虫（两道 `stale` 闸门 / `idRef` 必须跳过
   *   接回来的那些 id / 作废时 `releaseDecoded()` 把位图还回去）—— 搬的时候
   *   一条都没动，写状态的顺序也一字未改。
   * ⚠️ 选照片那三个 ref 留在 App 另一头（`onPick` 也写它们），从这里传进去。
   */
  const { loadSession } = useLoadSession({
    checking, user,
    pickStartedRef, pickSeqRef, pickSettledSeqRef, baseSeqRef, idRef,
    editPendingRef, dirtyRef, originalFileRef,
    setImage, setParams, setLut, setMessages, setCards, setHistory, setSavedId,
    setCompareSrc, setOriginalPreview, setBusy, setNotice,
    setCurrentSession, setSessionName, moveCursor, clearTransient, dismissAsk, flushEdit, flushPersist, noticeBad,
  })

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
  // ★ 2026-10-05：最新一步的 id —— `applyDecision` 判"要不要先问一句"用它。
  const tipId = history.length > 0 ? history[history.length - 1]!.id : null

  const { say, runGenerate, stopGeneration, applyDecision, loadCards, nextId,
    // ★ 2026-10-10：失败重试（「再试一次」）——`retryId` 是哪条失败消息上挂按钮，
    //   `retryGeneration` 是点它的动作（失败现场存在 hook 里，这里只转发）。
    retryId, retryGeneration } =
    useGeneration({
      image, setImage, params, setParams, lut,
      // ★ 2026-10-05（T11）：说话那条路落滤镜的两样 —— `setLut` 落地、
      //   `lutsApi.luts` 把模型给的名字对成 id（写在 `applyDecision` 里）。
      setLut, luts: lutsApi.luts,
      baseSeqRef, idRef, setBusy, setUser, noticeBad,
      setCards, setPending, pendingRef, setMessages, setHistory,
      // ★ 2026-10-08（账本，Task 4）：生成的**定稿点** —— 结果落地之前先把
      //   没定稿的那一笔调色记进账本（spec §5.5）。
      flushEdit,
      // ★ 2026-10-05（设计 §4.5）：从旧步骤生成时挂确认条（`applyDecision` 用）。
      setPendingReplace,
      // ★ 2026-10-05（终审 I1）：`cursorId` 换成了它的**同步影子**（`cursorIdRef`）。
      //   `setCursorId` 这个名字留着、指向 `moveCursor` —— `useGeneration` 那边的
      //   类型一个字都不用改，而"写位置"从此只有一条路（state 和 ref 一起写）。
      //   为什么读的是 ref 而不是 state，见 `cursorIdRef` 的注释。
      tipId, setCursorId: moveCursor,
      cursorIdRef,
      // ★ 2026-10-08（账本，Task 7）：新版本出生 = 这一版的现在变了（换了底图）
      //   —— 记给落盘那边，下一趟 PUT 才把这一步的 `image` 送上去。
      markDirty,
    })

  // ── 工具行（★ 2026-10-06）：裁剪 / 点修的现场与提交 ──────────────────
  //   ★ 2026-10-08：两簇各整段搬进 `app/useCrop` / `app/useRetouch`（连
  //   `defaultCropRect`、`MAX_ERASE_PIXELS` / `ERASE_VEIL_PIXELS` 两个常量、
  //   以及各自文件头那段"这一层只管什么"）。这里只剩接线。
  //
  //   ⚠️ `tool`（当前开着哪个工具）留在 App：它是**三个工具共用**的那一格，
  //   两个现场都拿它当"要不要交出去"的判据（`cropScene` / `retouchScene`）。

  const { crop, openCrop, closeCrop, setCropAngle, pickCropAspect,
          cancelCrop, commitCrop, cropScene } = useCrop({
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  })

  const { retouch, setRetouch, erasing, openRetouch, closeRetouch, cancelRetouch,
          commitRetouch, retouchScene } = useRetouch({
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  })

  /**
   * 工具行点了一下：切工具，并顺手开 / 收各工具自己的现场。
   * ⚠️ 再点一下当前那颗 = 收回（`ToolBar` 传 null 进来）—— 那就等于「取消」。
   * ⚠️ 同一时刻只有一个工具（单选，spec §3.0）：开一个新的，等于把别的收掉
   *    （裁剪现场、点修的掩码都是**照当前照片**算的，混着放没有意义）。
   */
  const pickTool = (t: ToolId | null) => {
    setTool(t)
    if (t === 'crop') openCrop()
    else closeCrop()
    if (t === 'retouch') openRetouch()
    else closeRetouch()
  }

  // ── 对比（★ 2026-10-06，工具行第二颗）────────────────────────────────
  //  分屏那一层本身在 `ui/CompareSplit`（叠图 / 剪裁 / 拖把手），这一层只管
  //  两件事：**开没开**，以及**那份够清楚的原图**。

  /**
   * 「对比」开着没有（spec §3.0：它是个**开关**，不是模式）。
   *
   * ★★ 它**不算"工具开着"**（2026-10-06 裁定）：`viewLocked` / `resetKey`
   *   这两样只认裁剪。理由是 spec §3.3 那句"对比态里缩放 / 平移照常能用"——
   *   用户多半**正放大着**才去按对比，这时候把他拽回「适应窗口」正好毁掉这个用法。
   */
  const comparing = tool === 'compare'
  /** 「工具开着」= **裁剪**那种要占住手势的模式（「对比」是开关，不在里面）。 */
  const toolIsModal = tool === 'crop'

  // （`compareSrc` 的声明 ★ 2026-10-08 挪到了上面 —— 恢复会话的 hook 要清它；
  //   "对比"这一层的全部说明在 `makeCompareSrc` 那一段。）

  /**
   * 备一份够大的原图。两条路：手里有那个 `File` 就直接解开；没有（极少数 ——
   * `loadSession` 那次取原图失败了）就**再问服务端要一次**。
   * ⚠️ 恢复出来的会话**走的就是第一条路**：`loadSession` 会把服务端那份原始字节
   *   重新包成一个 `File` 放回 `originalFileRef`（见那边那段注释）。
   */
  const makeCompareSrc = useCallback(async (): Promise<string> => {
    const file = originalFileRef.current
    if (file) {
      const bitmap = await createImageBitmap(file)
      // ⚠️ `close()` 必须在 `finally` 里：`bitmapToDataUrl` 抛（拿不到 2D 上下文）
      //    的时候，写在下一行的那个 close 根本轮不到 —— 那张位图会一直占着
      //    GPU 内存，而这恰恰是异常路径，平时没人盯着它。
      try { return bitmapToDataUrl(bitmap, 0.9) } finally { bitmap.close() }
    }
    if (sessionId === null) throw new Error('手头没有原图（也没有会话）')
    const blob = await (await fetch(sessionOriginalUrl(sessionId))).blob()
    const bitmap = await createImageBitmap(blob)
    try { return bitmapToDataUrl(bitmap, 0.9) } finally { bitmap.close() }
  }, [sessionId])

  /**
   * 懒做：**开着对比、而且还没有那一份**时才去备（进来一次、备一次）。
   * ⚠️ `alive` 那一套照 `loadSession` 的老规矩写；但它**不是"防重复"用的** ——
   *   StrictMode 下 effect 会挂两次，第一次那趟会被 cleanup 作废、第二次那趟
   *   才是留下结果的那个。所以这里**不许**再拿一个"正在备"的 ref 挡第二趟：
   *   挡了的话第一趟的结果被作废、第二趟被自己挡住 —— 原图永远备不出来，
   *   而屏幕上看不出是为什么（这条在 `react-strictmode-alive-ref` 那笔账里）。
   */
  useEffect(() => {
    if (!comparing || compareSrc) return
    let alive = true
    void (async () => {
      try {
        const src = await makeCompareSrc()
        if (alive) setCompareSrc(src)
      } catch (e) {
        // 备不出来就说一句：不说的话屏幕上就是"按了对比、什么都没发生"。
        console.error('对比的原图没备出来', e)
        if (alive) noticeBad('原图没取回来，这次对比先算了吧。')
      }
    })()
    return () => { alive = false }
  }, [comparing, compareSrc, makeCompareSrc, noticeBad])

  /** 右下角那颗「对比」按的就是这个 —— 和工具行那颗**同一个开关**。 */
  const toggleCompare = () => pickTool(comparing ? null : 'compare')

  /**
   * ★ 2026-10-10：**去要一批建议卡片**（上传后那趟、和「帮我想想」那颗共用一份）。
   *
   * 分工照旧：`pickIdRef` 的序号保证**后一趟**的收尾不把**前一趟**的提示提前
   * 收掉（换照片 / 再点一次会撞）；"正在看…"那句提示最多挂 `SUGGEST_WAIT_MS`，
   * 到点就收 —— 卡片是可选件，绝不能让用户等它。
   * `void`：`loadCards` 自己吞掉所有错（它绝不 reject），这里也不等它。
   *
   * ⚠️ 抽出来时原文一个字没动（原来整段住在 `onPick` 里）—— `baseSeqRef` 那条
   *   `++` 留在**调用处**：它是"底图换了一版"，和卡片没有关系。
   */
  const runSuggest = useCallback((img: DecodedImage) => {
    const myPick = ++pickIdRef.current
    setSuggesting(true)
    const settle = () => { if (pickIdRef.current === myPick) setSuggesting(false) }
    const timer = setTimeout(settle, SUGGEST_WAIT_MS)
    void loadCards(img).finally(() => { clearTimeout(timer); settle() })
  }, [loadCards])

  /**
   * ★ 2026-10-10：加号工具行里那颗**「帮我想想」** —— 再要一批建议。
   *
   * 加它的来路：卡片只在上传后出一次、10 秒就收掉，之后**再没有入口**
   * （接口 `/api/suggest` 一直是现成的）—— 用户改了两轮之后想问"还能怎么弄"，
   * 没有地方问。
   *
   * `setCards([])`：**换一批**，不是往旧的后面叠（旧的说的还是上一版画面）。
   * 忙的时候不接（和卡片本身同一条：生成在跑时点卡片会撞上闸门）。
   */
  const onAskSuggest = useCallback(() => {
    if (!image || busy || suggesting) return
    setCards([])
    runSuggest(image)
  }, [image, busy, suggesting, runSuggest])

  const onPick = useCallback(async (file: File, wish = '') => {
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
      closeBitmaps(bitmapsToClose(history, []))
      // ★ 2026-10-08（账本）：上一张照片那个"没定稿的半截笔"跟着一起作废 ——
      //   下面紧接着就把 history 整段换成新的一张了（不清的话它会一直堵着
      //   下一次"起一笔"，直到某一拍 `flushEdit` 发现找不到那个 id 才自己散掉）。
      //   ★ 落盘那本账（`dirtyRef`）同一批清：它记的是**上一张照片的那几版**。
      editPendingRef.current = null
      dirtyRef.current = null

      originalFileRef.current = file
      setImage(img)
      // ★ 2026-10-09：对话栏顶上那个名字 —— **先用文件名顶着**（和这一趟
      //   送上去的 `createSession(…, file.name)` 是同一个值，也就是服务端
      //   接下来存在 `original_name` 上的那个）。建会话那趟还要一会儿，
      //   等它回来才写的话，顶上会先空一格再补上。
      //   ⚠️ 和 `setImage` 之间**不能有 await**（同一个批次里一起落地，
      //   否则会先闪一帧上一个名字）。
      setSessionName({ title: null, originalName: file.name })
      // ★ 2026-10-06（对比）：上一张那份"对比用的原图"作废 —— 不清的话，
      //   换一张照片之后按「对比」，分屏左边还是**上一张**（而且一点不报错）。
      setCompareSrc(null)
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
      // ★ 2026-10-03：用户在**欢迎页的对话区**里先打的那句话 —— 带进对话输入框
      //   （`ChatPanel` 的 `draft`）。走的是"先说要改什么、再选照片"那条路；
      //   从修图页里换图（没有欢迎页）时它是空串，等于什么都不做。
      setDraft(wish)
      // 点选那套状态跟对话是同一趟的东西：换张照片就该一起归零，否则上一张照片
      // 的红圈和"原来那句话"会跟到新照片上。那条"要切掉后面吗"也是同一批 ——
      // 切照片 = 屏幕上换了一张图，它说的那件事已经不存在。今天到不了（换图 =
      // 重开一次），一行保险，和 `resetEditor` / `loadSession` 里那两处是同一条
      // 防线（理由都在 `clearTransient`）。
      clearTransient()
      // 「上次那张要替换掉吗」记的是**这张照片**那一趟 —— 换了一张，
      // 那个"上次那张"就不存在了，再问就是拿别人的图问（§3.4）。
      setSavedId(null)

      // 原图自己也算一步，挂在欢迎语那条消息上 —— 这样「回到这一步」
      // 能回到最开始，撤销第一次生成时特别有用。
      const welcomeId = say('准备好啦，说说想怎么改？')
      // 缩过就得说。紧跟欢迎语，用户往下看第一眼就撞上，不会滑过去。
      if (note) say(note)
      setHistory([
        // 账本（2026-10-08）：出生 = 只有当前位置一笔。
        { id: welcomeId, label: '原图', base: img, params: ZERO, lut: null, isOriginal: true, thumb: '', past: [], future: [] },
      ])
      // ★ 2026-10-05：位置从"原图那一步"开始 —— 原图挂在欢迎语那条消息上。
      //   ⚠️ 走 `moveCursor`（state + 影子 ref 一起写，见 `cursorIdRef`）。
      moveCursor(welcomeId)

      // 卡片是**可选件，绝不能让用户等它**：挂到后台去跑，发送键立刻可用
      // （序号 + 超时那套在 `runSuggest` 里，和「帮我想想」共用一份）。
      baseSeqRef.current++
      runSuggest(img)

      // ★ 在服务端把这条会话立起来。**不 await** —— 建会话是"锦上添花"，
      //   等它等于把用户挡在门外（上传那一步已经有一句"正在打开照片…"了）。
      //   建失败也**不影响本地修图**，但要说一声（见下面 catch）。
      //
      // ⚠️ ★ 2026-10-08（Task 7）：建会话送上去的那张图**不需要在这儿记一笔**
      //   了 —— 老代码在这里写过 `lastPersistedBaseSeqRef`（"这一版底图服务端
      //   已经有了，别再传一遍"），那个记号随 Task 7 退役。今天"服务端已经有了"
      //   由**没有待办**（`dirtyRef.current === null`）来表达，而上传这条路上
      //   本来就不会有待办（`onPick` 刚刚把整个 history 换掉）。
      //   ⚠️ **别顺手改成 `dirtyRef.current = null`**：这趟 `await` 的几十~几百
      //   毫秒里用户完全可能已经动了手（拖了个滑块、甚至裁了一刀）—— 那些待办
      //   是**这一张新照片**的，清掉就是"那一下永远不落盘，而屏幕上照变"。
      //   老代码在这儿记的是**发号之前**的那个版本号（`baseSeqAtCreate`），
      //   所以那个形状恰好没这个坑；换成"清待办"就有。什么都不做才是对的。
      //
      // ⚠️ `setCurrentSession(null)` 这一行是**给同一趟里再换一张照片**留的保险：
      //   上一张的 id 还留着的话，落盘副作用会把**这一张**的步骤和消息写进
      //   **上一条会话**里 —— 串会话，而且不报错。（今天应用里没有"换一张"的
      //   入口 —— 换图 = 重开一次，所以这一行到不了；一行保险，留着。）
      setCurrentSession(null)
      void (async () => {
        try {
          // `makeThumbnail` 是**同步**的（返回 data URL 字符串），别手滑写 await。
          const thumb = makeThumbnail(img.bitmap, GALLERY_THUMB_MAX_SIDE)
          const { id } = await createSession(bitmapToDataUrl(img.bitmap), thumb, file.name)
          // ⚠️ 只在**这张照片还是当前那张**时才认这个 id：
          //   用户可能在等的时候又换了一张（那会让这个 id 变成上一条会话的）
          if (originalFileRef.current === file) setCurrentSession(id)
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
  }, [history, say, runSuggest, setCurrentSession, moveCursor, clearTransient])

  /**
   * ★ 2026-10-10：**拖/粘进来的一张照片 = 换一张改**（和顶栏「新的一张」
   * 同一趟处理，只是不走"回欢迎屏再选"那两步）。
   *
   * 三句的顺序照 `startNew`：
   *   · `busy` 时不接（生成回来会往 history 里推一步，而屏幕已经换了底图）；
   *   · 先 `flushEdit`（"没定稿的一笔调色"记进账本）再 `flushPersist`
   *     （欠的那趟落盘提前发出去）—— 状态马上要换新的一张，不 flush 就丢了；
   *   · 最后 `onPick`：解码、建新会话、重置（旧的那条会话在左栏「对话」里
   *     原样留着，不删）。
   */
  const onDropPhoto = useCallback((file: File) => {
    if (busy) return
    flushEdit()
    flushPersist()
    void onPick(file)
  }, [busy, flushEdit, flushPersist, onPick])

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
    closeBitmaps(bitmapsToClose(history, []))
    // ★ 2026-10-08（账本）：照片都放下了，那个"没定稿的半截笔"也没有意义了 ——
    //   下面就是 `setHistory([])`。⚠️ `onSessionDeleted` 走的就是这条路，
    //   所以"整段换掉 / 清空 history"的每一处（`loadSession` / `onPick` / 这里）
    //   在这一行上齐了。
    //   ★ 落盘那本账（`dirtyRef`）同一批清 —— 没有照片了，就没有"哪一版脏了"。
    editPendingRef.current = null
    dirtyRef.current = null
    setImage(null)
    setHistory([])
    // ⚠️ 走 `moveCursor`：归零也要连影子 ref 一起清（不清的话，下一条会话里
    //   读 ref 的那一处会拿到上一张照片的位置 —— 正是 `cursorIdRef` 要防的事）。
    moveCursor(null)
    setMessages([])
    setCards([])
    setParams(ZERO)
    // ★ 2026-10-05（滤镜）：滤镜跟参数一起归零 —— 它是"这张照片上盖着的那层
    //   颜色"，照片都没了还留着它，下一张照片一进来就被盖上一层（而且因为
    //   `useLuts` 挂在 `image` 上，缩略图也跟着作废了，格子上还亮着，很怪）。
    setLut(null)
    setSavedId(null)
    // ⚠️ 归零 = "这一趟还没挂到服务端上"（下一次上传会建一条新的）。不归零的话，
    //   落盘那个 effect 会带着**新照片**的消息和步骤去写**上一条**会话。
    //   （同一趟里再换一张照片那条路也有这道保险 —— 见 onPick 里 `setCurrentSession(null)`
    //    那一段；这里从另一头把它做成了正经入口。）
    setCurrentSession(null)
    // ★ 2026-10-09：对话栏顶上那个名字跟着走 —— 照片都放下了，还留着上一条会话
    //   的名字，下一张照片一进来，顶上会先挂着**别人的名字**（`onPick` 会当场
    //   改掉它，但"先闪一下"和"`onSessionDeleted` 之后一直挂着"都不该有）。
    setSessionName(null)
    // 上一条照片那些**临时**状态：点选流程、"上次那张要替换掉吗"、原图预览。
    // 留着的话红圈会钉在下一张照片上，而「替换」问的是上一张存过的那条作品；
    // 那条"要切掉后面吗"同理 —— 照片都换了，它说的那件事已经不存在
    // （一对 setState 的完整理由在 `clearTransient`）。
    clearTransient()
    // ★ 2026-10-06（裁剪）：工具和裁剪现场也一起收 —— 它们是**照上一张照片**
    //   算的（框、内接区、比例里的"原始"全按它来），留着就是让下一张照片
    //   一进门就顶着一个别人的框。
    // ★ 2026-10-07（点修）：涂抹现场同理，而且更要紧 —— **掩码的尺寸就是
    //   上一张照片的尺寸**（图片像素的缓冲区），留着的话下一张照片一进来，
    //   掩码要么对不上号（提交时报"掩码尺寸对不上"）、要么落点全错。
    setTool(null)
    closeCrop()
    closeRetouch()
    dismissAsk()
    setOriginalPreview(null)
    // ★ 2026-10-06（对比）：那份备好的原图同理（上面那句的同一个理由）——
    //   留着的话下一张照片一进来按「对比」，左边是**上一张**。
    setCompareSrc(null)
    originalFileRef.current = null
  }, [history, setCurrentSession, dismissAsk, moveCursor, closeRetouch, clearTransient])

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
   * ⚠️ **合流点做三件事**（少写哪一条，屏幕上那套颜色就和拟合的世界对不上）：
   *   ① 六个拟合参数被**换掉**（`MatchedTone` 只有六个键 —— 想整份替换过不了
   *      typecheck）；
   *   ② **五条参与颜色的新参数被归零**（自然饱和度 / 三条色彩平衡 / 分离色调强度）：
   *      拟合是从 `ZERO` 起跑的，它的世界里这五条就是 0 —— 用户先拖过色彩平衡
   *      再"照着调"，不归零的话结果里会**悄悄混进**拟合没看过的色偏，而画面
   *      看起来"就是有点不对"，无从排查。两条**色相不归零**（强度为 0 时它们
   *      本来就不起作用，清掉反而是丢用户挑的颜色）；
   *   ③ 清晰度和暗角**原样留着**：那两个跟"参考图长什么样"没关系 ——
   *      暗角是构图选择，清晰度是局部细节。
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
      setParams(p => ({
        ...p,
        ...matched,
        // ★ 2026-10-04：五条参与颜色的新参数归零 —— 拟合从 `ZERO` 起跑，它的世界里
        //   这五条就是 0（理由见上面那段 ⚠️）。逐条写死（同 `clampAdjustments` 那条
        //   道理：漏掉一条，编译期就红 —— 返回值必须是完整的 `Adjustments`）。
        //   两条色相**故意不在这儿**：强度为 0 时它们本来就不起作用。
        vibrance: 0,
        cbCyanRed: 0,
        cbMagentaGreen: 0,
        cbYellowBlue: 0,
        splitAmount: 0,
      }))
    } catch {
      noticeBad('这张参考图打不开，换一张试试')
    } finally {
      ref?.bitmap.close()
    }
  }, [image, noticeBad])

  /**
   * 「照着这张调」的**第二条来源**（★ 2026-10-05，用户：「这个用户应该有两个
   * 来源，一个是以往作品效果，一个是本地照片」）：参考图来自自己的作品。
   *
   * 流程：取作品图的字节（`fetchWorkImage` —— 采样前反正要缩到 96px，要的就是
   * 小图，不拿原图省流量）→ 包成 `File` → **和本地文件合流进 `matchReference`**。
   * 两条来源在合流点收成一条：解码、拟合、归零那一整套一个字都不重复。
   *
   * ⚠️ 取图失败要**说**（和本地那张"打不开"同一族的错误）：这条路的图在服务器上，
   *    网络可能不给 —— 静默失败就是"点了没反应"。解码失败那半句由
   *    `matchReference` 自己说（它拿到的 File 长得和本地选的一模一样）。
   */
  const matchWork = useCallback(async (w: WorkMeta) => {
    if (!image) return
    let blob: Blob
    try {
      blob = await fetchWorkImage(w)
    } catch {
      noticeBad('这张作品没取到，换一张试试')
      return
    }
    await matchReference(new File([blob], 'reference'))
  }, [image, matchReference, noticeBad])

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
    // ★ 2026-10-08（账本）：和落盘一样，**先定稿再走** —— 照片马上要放下了，
    //   那一笔不记就永远没了（`resetEditor` 会把整个 history 清掉）。
    flushEdit()
    flushPersist()
    resetEditor()
  }, [busy, flushEdit, flushPersist, resetEditor])

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

  /**
   * 内部失效（跳转 / 又说一句话 / 点卡片 / 换照片）：清掉、**不吭声** ——
   * 用户已经走了。和「算了」那颗按钮分开写（那颗要说一句收尾）。
   *
   * ⚠️ 摆在 `send` 前面（而不是 `cancelPick` 旁边）：`send` / `onCard` 的
   *   依赖数组在**函数体执行到这里时**就要读它，落在后面就是 TDZ（整页白屏）。
   */
  const cancelReplace = useCallback(() => setPendingReplace(null), [])

  /** 按钮「算了」：清掉**并且**说一句收尾 —— 不能点了没反应。 */
  const declineReplace = useCallback(() => {
    setPendingReplace(null)
    say('好，那就不动这一步。')
  }, [say])

  /**
   * 按钮「继续改」：**到这里才说话、才花钱、才切**（设计 §4.5）。
   * 参数/滤镜读**此刻的**：说话那条路 = 决策算出的 + 期间拖的；再来一版
   * = `onJump` 之后 = 那一步的 —— 和"这一步做完之后的状态"口径一致。
   */
  const confirmReplace = useCallback(() => {
    if (busy || !pendingReplace || !image) return
    const p = pendingReplace
    setPendingReplace(null)
    // ★ 2026-10-06：只发号、**不插消息** —— `p.reply`（"好，这就去改。"那句）
    //   由 `runGenerate` 在**生成成功那一刻**和图片一起说（用户原话：「对话区
    //   AI 回复的太快，它跟图片应该是同时出的」）。原来在这儿 `say`，同样是
    //   "先冒一句、再干等十来秒"。号仍然是这条助手消息的 id，由调用方先发。
    const mid = nextId()
    void runGenerate(p.editPrompt, mid, params, lut, image.bitmap,
      { stepId: p.stepId, keepFromMsg: p.keepFromMsg ?? mid }, p.reply)
    // ⚠️ 依赖数组里去掉了 `say` —— 这个回调不再用它了（按"读到的才写进依赖"）。
  }, [busy, pendingReplace, image, params, lut, runGenerate])

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
    // ★ 2026-10-05（设计 §4.5）：上一条"要切掉后面吗"也一起翻篇 ——
    //   和上面那一行同一条规矩（用户已经走了，不吭声地清掉）。
    cancelReplace()
    // ★ 2026-10-05：id 要留着 —— 它是"本条指令的第一条消息"（切口切对话时
    //   从它起保留，设计 §4.3）。原来的内联 `nextId()` 拿不到它。
    const uid = nextId()
    setMessages(m => [...m, { id: uid, role: 'user', text }])
    setCards([])
    // ★ 2026-10-06（用户原话：「而且中途思考要有一些加载动作比如正在思考，要让
    //   用户知道你在干嘛」）：这一段写「正在思考…」—— 原来写「正在看照片…」，
    //   说的是**我们的动作**；接下来那 1.3~1.6 秒是模型在读这张照片、想你这句
    //   话该怎么改，用户要的"知道你在干嘛"就是这个。生成那段（"正在改…大约
    //   10 秒"）一个字没动，上传/切会话那两句也没动。
    setBusy('正在思考…')
    // ★ 2026-10-05（终审残留）：记下"这一趟出发时是哪条会话、哪一版底图"。
    //   `postRoute` 要等 1.3~1.6 秒，而切会话 / 换照片都**没有** busy 闸门 ——
    //   不记的话，决策回来会把这趟落到**别人会话**上：轻则弹一条"后面还有 0 步…"
    //   的胡话，重则（两条会话步骤数相同、id 撞号）静默把这张照片的生成写进
    //   另一条会话 —— 串会话，错了不报错。判据和 `runGenerate` 里那道
    //   `seqAtStart` 守卫同一族：那边守"生成回来时人已经走了"，这边守
    //   "还没开始生成，人就已经走了"。
    const sidAt = sessionIdRef.current
    const seqAt = baseSeqRef.current
    try {
      // 路由看的是**用户此刻看到的画面**（含已生效的参数），这样模型给的
      // 增量才是相对当前效果的。生成那一路送的是**当前 base**（同样不带
      // 参数——铁律保证，见 spec §3.5），所以两边都不会把颜色烤进像素。
      const preview = await prepareForRouting(canvas)
      // ★ 2026-10-05（滤镜 T11）：说话那条路要认得滤镜，靠的就是这两样 ——
      //   `luts` 是清单（**模型只能从里面照抄名字**，只给名字不给内容），
      //   `lut` 是此刻手上那个（只当上下文写进提示词）。
      const decision = await postRoute({
        imageDataUrl: preview.dataUrl, text, params,
        luts: lutsApi.luts.map((l) => ({ id: l.id, name: l.name })),
        lut,
      })
      // ⚠️ 两样都要比：`baseSeqRef` 覆盖换照片（上传/生成都会推它），
      //   `sessionIdRef` 是"会话"这一层的直说。
      //   ⚠️ `sidAt === null` 时**不比会话这一样**：上传后立刻说话时建会话还在
      //   半路（`onPick` 里那句是不 await 的，而 `busy` 早清了）—— 它会在这段
      //   窗口里把 `sessionIdRef` 从 null 拨成 id，那是**同一张照片的同一条会话
      //   在长出来**（`onPick` 有 `originalFileRef.current === file` 守着），
      //   不是"人走了"。比了就是拿一句"画面已经变了…"的**假话**把用户刚说的话扔掉
      //   （2026-10-05 探针实测到，见「上传后立刻说话、建会话这时才回来」那条用例）。真换会话 / 换照片
      //   几条路**都推 `baseSeqRef`**（`loadSession` / `onPick` / `onSessionDeleted`
      //   各一处），`startNew` 走的是 `sidAt` 非 null 那一半 —— 漏掉 null 这一小格，
      //   一个真出口都漏不掉。
      //   ★ 2026-10-06（终审 I2）：**裁剪**也推 `baseSeqRef`（同属"底图换了一版"），
      //   所以这道闸拦下的不只是"人走了" —— 通报那句必须两边都成立（见下面那行）。
      if ((sidAt !== null && sessionIdRef.current !== sidAt) || baseSeqRef.current !== seqAt) {
        noticeBad('刚才那句话还没算完，画面已经变了 —— 这边没动它。要的话，再说一遍。')
        return
      }
      await applyDecision(decision, uid)
    } catch (e) {
      console.error(e)
      // 同上：票失效不是"出了点问题"，是"你得再登录一次"——而这句话只有在
      // 登录页上才成立。回登录页，不是留一句提示。
      if (isUnauthorized(e)) { setUser(null); return }
      say(errorText(e, '出了点问题，再试一次？'))
    } finally {
      setBusy(null)
    }
    // `image` 进了守卫，就必须进依赖数组——否则这个回调会永远看到第一次
    // render 的 image（null），上传后一句话都送不出去。
    // ★ T11 追加 `lutsApi.luts` / `lut`：两个都进了请求体，同一条规矩。
    //   ⚠️ 依赖写 `lutsApi.luts`（那份数组），别写 `lutsApi` —— 后者每次渲染
    //   都是新对象，等于这个回调每渲染重建一次（`refreshLuts` 那边有同款注释）。
    // ★ 2026-10-05：`cancelReplace` 同上（上面那一行清它）。
    // ★ 2026-10-05（终审残留）：`noticeBad` 也进来 —— 挡住的那一趟要说一句
    //   （"画面已经变了…"）。它身份稳定，但按这个文件的规矩：**读到的就写进依赖**。
    //   两个 ref（`sessionIdRef` / `baseSeqRef`）是稳定身份，不进依赖。
  }, [busy, params, applyDecision, say, image, lutsApi.luts, lut, cancelReplace, noticeBad])

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
    // ★ 2026-10-05（设计 §4.5）：上一条"要切掉后面吗"同一条规矩 ——
    //   "确认条和卡片同时在屏上"真会发生（卡片会迟到），不清的话点下去切的是别处。
    cancelReplace()
    // ★ 2026-10-05：和 send 一样 —— `uid` 是"本条指令的第一条消息"（切口靠它
    //   划出"现在"和"过去"）。
    const uid = nextId()
    setMessages(m => [...m, { id: uid, role: 'user', text: card.label }])
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
      // ★ 2026-10-05（滤镜 T11）：卡片不碰滤镜（`SuggestCard` 里没有这个字段，
      //   今天推荐卡片只说调色和结构性改动）—— 新增字段就要在这里表态。
      lut: null,
    }, uid)
    // ★ 2026-10-05：`cancelReplace` 同上（onCard 里那行清它）。
  }, [busy, applyDecision, say, cancelReplace])

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
    if (!marker || !pendingText || !pendingKeepFrom || !image || cursorId === null) return
    const text = pendingText
    setPending(null)
    // ★ 先**发号**、拿这条消息的 id，再拿它去调 runGenerate —— 插消息那一步
    //   （和图片同批落）在 runGenerate 的成功路径里，用的就是这个号。
    //   缩略图（`thumbs[m.id]`）和「回到这一步」（`jumpableIds.includes(m.id)`）
    //   两处都是按消息 id 对号的：号必须和真正落下来的那条助手消息**同一个** ——
    //   对不上的话两样会**一起静默失效**：用户点完圈，画面上什么都没多，
    //   也没法回到这一步。花钱买来的东西反而看不见，是这个项目最亏的一种错。
    //   ★ 2026-10-06：原来这行是 `say('好，就改这里。')`（话当场说、id 顺带拿）；
    //   现在话留给 runGenerate 在**生成成功那一刻**说（和图片一起出，用户原话），
    //   号还是在这里发 —— 它同时是 `messageId` 和这条助手消息的 id。
    const mid = nextId()
    // 和 applyDecision / send / onCard 一样清掉建议卡片：卡片**会迟到**
    // （上传时那次请求超时后仍在后台跑、回来了照样贴上来），所以"确认条与卡片
    // 同时在屏上"真会发生。那批卡片是按**生成前那张照片**算出来的 —— 不清的话
    // 它们会活过整个生成，生成一结束就又能点，点一下再花一次钱。
    setCards([])
    try {
      const marked = markImage(image.bitmap, marker)
      // ★ 2026-10-05（滤镜）：传**当下**的 `lut`（这条路就是"此刻这张照片"，
      //   没有跳转，和 `params` 一样）。⚠️ 因此 `lut` 必须进下面那个依赖数组。
      // ★ 2026-10-06：末参 `'好，就改这里。'` 那句话推迟到生成成功才说（见上）。
      await runGenerate(text, mid, params, lut, marked,
        { stepId: cursorId, keepFromMsg: pendingKeepFrom }, '好，就改这里。')
    } catch (e) {
      console.error(e)
      say('这一步没成功，再试一次？')
    }
  }, [busy, marker, pendingText, pendingKeepFrom, image, cursorId, params, lut, runGenerate, say])

  const onJump = useCallback((id: number) => {
    const target = history.find(s => s.id === id)
    if (!target) return
    // ★ 2026-10-08（账本，Task 4）：跳走之前**先把没定稿的那一笔定下来** ——
    //   版本之间不许出现"半截笔"。用户"调完马上跳到下一版"时，那一笔要是
    //   没定稿，之后回来它就没了（而屏幕上明明看得见颜色变了）。
    flushEdit()
    // ★ 2026-10-08（账本，Task 7）：再把它**欠的那趟落盘**也发出去（spec §7.2
    //   的"版本跳转前 flush"）—— 跳走 = 那一版离开视线，它欠的账先结掉，
    //   也就**消灭了"两版同时脏"**（不结的话：第二版那趟还排在 800ms 的队里，
    //   而人已经站在第一版上拖滑块了 —— 两版的待办在同一个 `dirtyRef` 上打架，
    //   先排的那趟会被后一笔盖掉）。
    //   ⚠️ 顺序：**先定稿、再 flush**（`flushEdit` 刚记的那一笔在落盘 payload 里
    //   是账本的那半，而状态那半（params/lut）本来就已经镜像进快照了）。
    //   ⚠️ 和 `loadSession` 进门第一句那对是同一个形状（那边也是两个 flush 一起打）。
    flushPersist()
    // ★ 「回到这一步」也是"改主意了"：上一条歧义就此翻篇 —— 和 send / onCard
    //   里那几行同一个道理，所以用同一个 cancelPick。
    //   （原来的那两条竞态理由照旧成立，见 git 历史。）
    cancelPick()
    // ★ 2026-10-05（设计 §4.5）：上一条"要切掉后面吗"就此作废 —— 和
    //   `cancelPick` 一字不差的同一条规矩（不清的话，确认条会停在屏上，
    //   而它说的那件事已经翻篇 —— 点下去切的是别处）。
    cancelReplace()
    // ★ 2026-10-05：「回到这一步」**不再删后面的步骤**（用户原话：「用户点击回到
    //   这一步后，应该保留更改的那一步」）。它只做一件事：移动"现在站在哪一步"。
    //   被跳过的步骤留在 history 里 —— 图、小图、两颗按钮都还在，随时能再点回去；
    //   它们的位图也不再提前释放（那是"还能再回去"的本钱）。
    //   真正会切掉后面的只有一条路：**从这个位置再生成**（`runGenerate` 的
    //   `origin`，设计 §4）—— 而且那一步会先问一句。
    //   ⚠️ 走 `moveCursor`：这一下**必须**连影子 ref 一起写 —— 路由那 1.3~1.6 秒
    //   里用户点的就是它，而 `applyDecision` 此刻可能还挂在旧闭包里（终审 I1）。
    moveCursor(id)
    // 画面 / 参数 / 滤镜一起还原（三样缺一不可，理由全在 `applySnapshot` 那段 ——
    // ★ 2026-10-08 收口：这句三连原来在 `onJump` / 删记录 / 翻账本三处各写一遍）。
    // ⚠️ `target` 来自 `history`，它本来就在依赖数组里。
    applySnapshot(target)
    // ⚠️ `flushPersist` 进了依赖数组（上面读到了它）—— `flushEdit` 本来就在里面。
  }, [history, cancelPick, cancelReplace, moveCursor, applySnapshot, flushEdit, flushPersist])

  /**
   * ★ 2026-10-08（调色区账本，Task 4）：调色屏左下角那组箭头 —— 翻的是
   * **当前这一版的账本**，不是版本（版本归修图屏的转盘管；宏观 = 转盘、
   * 微观 = 这一组，是用户点名的分工，spec §5.3）。
   *
   * ⚠️ **动之前先把没定稿的调色定稿**（"调完马上退"退的必须是**他刚调的那下**）。
   *   这里不能写成"`flushEdit()` 然后等一下渲染再读" —— `setHistory` 是异步的，
   *   这一拍读到的 `cur` 还是旧的。所以就地算一份"定稿后的它"（`base`），
   *   在**同一拍**里 undo / redo 它。
   * ⚠️ 不碰对话、不切步骤、不花钱 —— 和"翻版本"同一族契约（`39fb4d0`）。
   * ⚠️ 位置（`cursorId`）**不动**：翻账本翻的是"这一版现在的样子"，不是跳到别的版本。
   */
  const ledgerStep = useCallback((dir: -1 | 1) => {
    const cur = history.find(s => s.id === cursorId)
    if (!cur) return
    // 先把待办定稿，在同一拍里拿到"定稿后的它"（不能只 setHistory 等渲染）
    let base = cur
    const p = editPendingRef.current
    if (p && p.stepId === cur.id) {
      editPendingRef.current = null
      const next = { base: cur.base, params, lut }
      if (!sameEdit(p.before, next)) {
        const seq = ++editSeqRef.current
        base = pushEdit(cur, { ...p.before, seq }, next, seq)
      }
    }
    const target = dir < 0 ? undoEdit(base) : redoEdit(base)
    // ⚠️★ 2026-10-08（评审 Important）：这里判"到头"要**两个条件一起**。
    //   只看 `target === base` 会吃掉两种情况，而其中一种是**真的有事发生**：
    //   账本在中间（future 非空、「下一步」可点）时拖了一下滑块 —— 上面那下
    //   内联 `pushEdit` **清空了 future**，于是紧接着的 `redoEdit` 返回**同一引用**，
    //   `target === base` 成立。直接 return 的后果是"错了不报错"的两条：
    //     ① 刚定稿的那一笔连 `setHistory` 一起丢掉（画面照变 —— 之后按「上一步」
    //        会一次退掉两件事）；
    //     ② 那颗「下一步」看着能点、点了什么都不发生。
    //   `base === cur` 才叫**真到头**（什么都没变：没定稿、也没得退/进）。
    //   反方向（`dir < 0`）不受影响：内联记账只往 `past` 里加，而 `undoEdit` 只在
    //   `past` 空时返回原引用 —— 那时候「上一步」本来就按不动。
    if (target === base && base === cur) return
    // ★ 2026-10-08（Task 5）：上面那一拍**真的记了一笔**（`base` 换成了新快照）
    //   就顺手过一遍预算闸 —— 那一笔多半没新位图（调色笔零成本），但账本形状
    //   和别处一样，**别搞特例**。没记那一笔（纯翻账本）就不用过。
    const flushed = base !== cur
    setHistory(h => {
      const next = h.map(s => (s.id === cur.id ? target : s))
      return flushed ? settleLedger(h, next) : next
    })
    // 画面 / 参数 / 滤镜一起还原（同 `onJump` 那句，★ 2026-10-08 收口）；
    // 翻账本**不动"站的位置"**，所以只还原、不 `moveCursor`。
    applySnapshot(target)
    // ★ 2026-10-08（Task 7）：**翻账本也是改"这一版的现在"** —— 退一步 / 进一步
    //   都可能换掉底图（翻到"裁之前/裁之后"那一笔）和调色。判据就是底图的
    //   **对象身份**：同一条链上的调色笔共用同一个位图对象（账本的不变量 ②），
    //   只有真换过像素的那几笔才不是 —— 换过就得把这张位图重传给服务端
    //   （`baseChanged`），没换过只送参数。
    markDirty(cur.id, target.base !== base.base)
  }, [history, cursorId, params, lut, markDirty, applySnapshot])

  /**
   * ★ 2026-10-08（调色区账本，Task 4）：调色区的**现场**与「当前这一版」之间
   *   那条链 —— 三件事（原 `549836b` 那条"只在最新一步写回"的**放宽版**）：
   *
   *   ① **现场镜像**：把 live `params` / `lut` 立刻写回**当前这一版**。
   *      原来是"只在最新一步"（`cursorId === last.id`）；账本落地后放宽到
   *      "**当前这一版**"—— 站在旧版本上改的，该写回**旧版本**（账本、落盘、
   *      跳转读的都是快照上这一份，不改的话这一次改动是"本地有、跳走就没"）。
   *      来路（2026-10-08 用户报的）：套上滤镜 → 跳到第一版 → 跳回来，滤镜没了。
   *   ② **起一笔**：第一次跟快照不一样时，把"**改之前**"拍进 `editPendingRef`
   *      —— 一次**连续**调整只拍一次，连着拖几个来回合并成同一笔（spec §5.1）。
   *   ③ **定稿闹钟**：停手约 800ms 把它记进账本（`flushEdit`，和落盘同一档防抖）。
   *
   * ⚠️⚠️ **别把这段重写成 `early return` 的形状**（原来那条正是那样写的）：
   *   这条 effect 自己会改 `history`，而 `history` 在依赖里 —— 于是它**每次都要
   *   重跑一遍**。早返回的话，第一次跑起来立的那个闹钟会被自己的清理取消掉，
   *   而重跑又因为"第一句就 return"再也不重立 —— 那一笔**永远不会定稿**，
   *   而且一句错都不报。所以"立闹钟"那句要落在**两条路都会走过**的位置。
   *
   * ⚠️ 引用相等就什么都不做（`cur.params === params`）：`onJump` / 恢复会话 /
   *   删记录那几处还原时传进来的就是快照里**同一个对象** —— 不挡的话每次跳转
   *   都白 map 一遍、还多一轮渲染。
   */
  useEffect(() => {
    const cur = history.find(s => s.id === cursorId)
    // ① 现场镜像 + ② 起一笔（"改之前"取快照里那一份；只在没有待办时拍）
    if (cur && (cur.params !== params || cur.lut !== lut)) {
      if (!editPendingRef.current) {
        editPendingRef.current = {
          stepId: cur.id,
          before: { base: cur.base, params: cur.params, lut: cur.lut, seq: 0 },
        }
      }
      setHistory(h => h.map(s => (s.id === cur.id ? { ...s, params, lut } : s)))
      // ★ 2026-10-08（Task 7）：**这一版的"现在"变了** —— 落盘该认识它。
      //   `false`：调色/滤镜不换底图（`baseChanged` 只留给裁剪/点修/翻账本
      //   那几处真换像素的地方）。不记的话：拖完滑块刷新一下，颜色回到拖之前
      //   —— 而屏幕上当时什么都没说（正是这条 effect 与落盘之间那道缝）。
      //   ⚠️ 写在 `setHistory` **后面**、同一批里：`markDirty` 只动 ref、不触发
      //   渲染，所以它必须搭着上面那次 `setHistory` 一起让落盘 effect 重跑
      //   （重排那个 800ms 的闹钟），顺序反了也一样成立，但读起来是"先改快照、
      //   再记账"。
      markDirty(cur.id, false)
    }
    // ③ 定稿闹钟（没有待办 = 不立表）
    if (!editPendingRef.current) return
    const t = setTimeout(() => flushEdit(), 800)
    return () => clearTimeout(t)
  }, [params, lut, cursorId, history, flushEdit, markDirty])

  /**
   * ★ 2026-10-06（用户原话：「在会话里的单条记录我怎么还是没有删除的按钮」，
   *   下午又看了他发来的勾选框截图，选了"两个都要"）：删记录。
   *   **单条和批量是同一个函数** —— 菜单里那颗【删除】交一个 id，选择模式里
   *   交一串。光标、底图号、位图回收只有这一份实现。
   *
   * ★★ 2026-10-08（用户原话：「属于一段对话的记录被删除了，另一条对话记录
   *   还被保留这肯定不对的」+ 截图里两个没人回答的问句）：**删除的单位是
   *   一问一答，不是一条消息** —— 传进来什么 id，先按 `core/messages.ts` 的
   *   `expandDeleteIds` 补成整轮（每条带上它相邻的搭子）再动手。
   *   他的"一段对话"就是指一问一答（2026-10-06 他自己定的，也是「…」一轮一颗
   *   的依据）；只删半轮，屏幕上就剩一个孤零零的问句 —— 在他眼里就是坏掉了。
   *   ⚠️ 补搭子用**这一刻的 `messages`**（所以它在依赖数组里）。
   *
   * **带图那条连它身后那一步一起删**（图 / 参数 / 滤镜都挂在那一步上 ——
   * 只删消息的话，屏幕上一条话都没了、那个位置却还在，缩略图还会以"没有话的图"
   * 的样子杵在那儿）；纯文字那条只动 `messages`。补进来的搭子是纯数据（用户话
   * 永远不挂步骤，见"消息 id 就是步骤 id"那条老约定），所以"带不带图"的判据
   * 不受它影响。
   *
   * 那一条「删了就找不回来了」的**就地确认由 ChatPanel 做**（它才看得见"这条
   * 后面有没有一步"/"勾的里面有几步带图"）—— 走到这里就是用户已经点了
   * 「确认删除」（或者删的是纯文字那些）。
   *
   * ⚠️ 它和「回到这一步」/ 新消息一样是"改主意了"：点选和「继续改」那两条确认条
   *   一起作废 —— 不清的话，「继续改」会切在一个**已经删掉的位置**上。
   * ⚠️ `busy` 那道闸门是**真正**的拦住处（ChatPanel 里那些 disabled 只是反馈，
   *   和「再来一版」同一条规矩）：忙的时候删，等于在一次生成还在飞的时候动账本。
   * ⚠️ 不碰服务端：落盘那个 effect 会把"少送来的 id"写成删除（服务端 `mergeSteps`
   *   对没送来的 id 就是删），所以这条路**服务端零改动**。
   */
  const onDeleteMessages = useCallback((ids: number[]) => {
    if (busy) return
    // ★ 2026-10-08：先补成整问整答（菜单那条路只交一条；批选那条 ChatPanel
    //   已经补过了，这里是同一条纯函数的第二次调用 —— 幂等）。
    const kill = new Set(expandDeleteIds(messages, ids))
    if (kill.size === 0) return
    // ★ 2026-10-08（Task 5 顺手件）：**被删的那一版上挂着"没定稿的那一笔"的话，
    //   待办跟着它一起走**。不清的话：`editPendingRef` 还攥着一个**已经不存在的**
    //   stepId，而"起一笔"的判据是**待办为空**（同时只许有一个）—— 站在新那一版
    //   上怎么调都记不上一笔（颜色照变、箭头一动不动，一句错都不报），一直到某
    //   一拍 `flushEdit` 找不着那一版、自己把它散掉为止（而它永远等不到那一拍：
    //   定时器只在"有改动"时重立）。
    //   ⚠️ 判据是 `kill`（补成整问整答之后的集合）：待办挂的是一步的 id，
    //   而这一步正是被删的那些之一 —— 和下面 `history.some(…)` 那条判据同一份。
    const pend = editPendingRef.current
    if (pend && kill.has(pend.stepId)) editPendingRef.current = null
    cancelPick()
    cancelReplace()
    setMessages(m => m.filter(x => !kill.has(x.id)))
    // 这里面有没有"一步"？没有（纯文字那几条）→ 到此为止。
    if (!history.some(s => kill.has(s.id))) return
    // ★（评审 Important，2026-10-06）被删的里面有**最后一步**时，这一版底图
    //   **换人了** —— 两个记号各干各的，一行一个：
    //   · `baseSeqRef++` = **竞态闸门**（这个号今天只管"迟到的活儿还算不算数"，
    //     见 `baseSeqRef` 那段）；
    //   · `markDirty(新 tip 的 id, true)` = **落盘**：让下一趟 PUT 重新带上
    //     `base` + `thumb`（`baseChanged`）。不带的话服务端手里的封面还是
    //     **被删那版**的像素，而 `steps` 里已经没有它了 —— 重开就是"编辑器显示
    //     v1、左栏列表封面是 v2"，一句报错都没有。
    //   （用户最常见的路径正是"站在最新那步上把它删掉"——那时画布已经被下面
    //   那三行换成了新 tip 的样子，重传上去的封面就是对的。）
    //   删**中间**那些步不记：封面画的就是最后一步，那一步没动，封面本来还对。
    //   ⚠️ 已知角落（评审接受的取舍）：人站在**别的**步骤上删尾步时，重传的封面
    //   是他当时看的那一版（不是新 tip）—— 比"留着已删的那版"强，下一次生成自愈。
    //   ⚠️ `base` 那一半会送**新 tip 自己的位图**（`stateStepId` 指着它）—— 服务端
    //   会存成一份内容相同的文件。这份浪费是有意的：宁可多存一份，也不要让
    //   "底图"和"挂在哪一步"两半走岔（岔了就是刷新后某一版变回旧图）。
    const tipBefore = history[history.length - 1]
    if (tipBefore && kill.has(tipBefore.id)) {
      baseSeqRef.current++
      const newTip = history.filter(s => !kill.has(s.id)).at(-1)
      if (newTip) markDirty(newTip.id, true)
    }
    setHistory(prev => {
      const next = prev.filter(s => !kill.has(s.id))
      // 被删那几步的位图要还回去（原图不关 —— 它还要接着用）。副作用写在 updater
      // 里的写法照 `useGeneration` 那条：`close()` 幂等，StrictMode 重放也安全。
      closeBitmaps(bitmapsToClose(prev, next, { protectOriginal: true }))
      return next
    })
    // 站在被删的**某一步**上 → 挪到**剩下的最后一步**，画面 / 参数 / 滤镜照
    // `onJump` 那套一起还原（只挪光标不换画面的话，"你在这里"指着一步、屏幕上
    // 却是已经不存在的那张图）。⚠️ 用闭包的 `history`（它在依赖数组里）：这里
    // 没有 await，它和上面 updater 拿到的 `prev` 是同一份。
    if (cursorId !== null && kill.has(cursorId)) {
      const rest = history.filter(s => !kill.has(s.id))
      const tip = rest[rest.length - 1]
      if (tip) {
        moveCursor(tip.id)
        applySnapshot(tip)
      }
    }
  }, [busy, messages, history, cursorId, cancelPick, cancelReplace, moveCursor, applySnapshot])

  /** 删一条 —— 上面那本账的**特例**（`onDeleteMessages([id])`），给菜单里那颗【删除】。 */
  const onDeleteMessage = useCallback((id: number) => onDeleteMessages([id]), [onDeleteMessages])

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
    // 先回到那一步（base / 参数 / 滤镜 / 缩略图 / 点选清理，全都走同一条路）。
    onJump(id)
    // ★ 2026-10-05（设计 §4.5）：后面还有步骤的话，先把"会切掉它们"问出口。
    //   ⚠️ 顺序：必须在 `onJump` **之后** —— `onJump` 里会清掉旧的确认条
    //   （cancelReplace），倒过来写就是刚设上就被清掉（"点了没反应"）。
    const tip = history[history.length - 1]
    if (tip && tip.id !== id) {
      setPendingReplace({ stepId: id, editPrompt: target.prompt, reply: '好，又出了一版。' })
      return
    }
    // ★ 2026-10-06：只发号、**不插消息** —— 那句话由 `runGenerate` 在**生成成功
    //   那一刻**和图片一起说（用户原话：「对话区 AI 回复的太快，它跟图片应该是
    //   同时出的」）。⚠️ 这个号同时是下一行 `keepFromMsg: mid` 的边界，必须在这里
    //   先发（`runGenerate` 签名里那段把"先发号、后插消息"的约定写全了）。
    const mid = nextId()
    // ★ 2026-10-05（滤镜，复审 Important）：**传 `target.lut`**，不是"手上这个"。
    //   `onJump` 里那句 `setLut(target.lut)` 是 state 更新，**这一轮渲染里不生效**
    //   —— `runGenerate` 直接读闭包的话，新那一步会记成**跳转前**的滤镜，
    //   而画面（跳转后）是另一回事：和刚修掉的"小图 vs 主画面"是同一种不一致，
    //   只是走「再来一版」这条窄路。`params` 一直是显式传参才躲过了这一条。
    void runGenerate(target.prompt, mid, target.params, target.lut, target.base.bitmap,
      { stepId: id, keepFromMsg: mid }, '好，又出了一版。')
    // ⚠️ 依赖数组里去掉了 `say` —— 这个回调不再用它了（按"读到的才写进依赖"）。
  }, [busy, history, onJump, runGenerate])


  /**
   * 给"**当前这一版**"抓/重抓小图（★ 2026-10-08 账本 Task 8 重写）。
   *
   * **为什么不在推快照的地方直接抓**：快照是和 `setParams` / `setImage`
   * 同一个批次推入的，那一刻画布还没重画 —— 抓到的会是**上一步的颜色**，
   * 用户看到的小图和点进去的画面就对不上了。
   *
   * 这个 effect 跑在 Canvas 的渲染 effect **之后**（React 的被动 effect
   * 是子先父后），所以它看到的画布已经是这一步的样子了。
   *
   * ★ 2026-10-08（账本）：老形状是"**只给队尾那一步补一张**（`thumb` 空了才抓）"
   *   —— 账本落地之后它坏在两头：
   *     · 裁剪 / 点修 / 调色改的都是"**当前这一版**"，**id 不变、也不推新快照**，
   *       那一格的 `thumb` 非空 → 画面明明变了，转盘上还停在改之前的样子；
   *     · 站在旧版本上（不在队尾）时，队尾那一步根本不缺小图 → 什么都不做。
   *   所以判据从"这一格画过没有"换成"**这一版现在的样子变了没有**"：
   *   位置 / 底图 / 参数 / 滤镜四样里任何一样跟上次抓的时候不一样，就重抓。
   *   四样齐全才行：只认 id 会漏掉"同一版上又裁了一刀"，只认 params 会漏掉
   *   裁剪和点修（它们只换底图、不动调色）。
   *   ⚠️ 判据是**引用比较**（`===`）—— `base` 是位图，"宽高一样"不等于"同一张"
   *   （同一张图裁两次就是两个对象）；`params` / `lut` 每次改动都会换一个新对象
   *   （写回那条 effect 和记账那条路都是这个形状）—— 身份一变就说明改过，重抓。
   */
  const thumbStateRef = useRef<{
    id: number; base: DecodedImage; params: Adjustments; lut: LutRef | null
  } | null>(null)
  useEffect(() => {
    const canvas = canvasElRef.current
    if (!canvas || cursorId === null) return
    const cur = history.find(s => s.id === cursorId)
    if (!cur) return
    // ⚠️ **没定稿的拖动期间不抓**：拖一次滑块每一帧都会镜像进快照（`history`
    //   跟着换新），照抓就是**一秒 60 张缩略图**（每张都要开 2D 画布 + 编码
    //   JPEG）。等定稿（`flushEdit`，0.8 秒）那一拍再抓 —— 那时候
    //   `editPendingRef` 已经清掉，这一版的样子也定下来了（spec §7.3
    //   "与定稿同拍防抖"说的就是它）。
    //   ⚠️ 这个 ref 由**写回那条 effect**（"调色区的现场与「当前这一版」"，
    //   在它上面）在同一批里先设上 —— 两条 effect 的先后就是声明顺序，那条
    //   排在前头，所以拖动的第一帧这里就拦得住。
    if (editPendingRef.current) return
    const t = thumbStateRef.current
    if (t && t.id === cur.id && t.base === cur.base
        && t.params === cur.params && t.lut === cur.lut) return
    try {
      // ⚠️ 先把记号写上、再抓：`makeThumbnail` 抛的时候（拿不到 2D 上下文）
      //   记号已经落定 → 下一次不会为同一个状态再抓一遍（不然一次失败会让
      //   这个 effect 每次渲染都重试一次，报错刷屏）。
      thumbStateRef.current = { id: cur.id, base: cur.base, params: cur.params, lut: cur.lut }
      setHistory(h => attachThumb(h, cur.id, makeThumbnail(canvas)))
    } catch (e) {
      // 缩略图是锦上添花的东西，抓不到不该影响用户修图
      console.error('缩略图生成失败（不影响修图）', e)
    }
  }, [history, cursorId])

  // ★ 2026-10-08：落盘那个 800ms 防抖 effect（"把现在这一趟存回服务端"）和
  //   "页面要走了"那两条 keepalive 的 effect 整段搬进 `app/usePersist` ——
  //   连 effect 尾巴上那六条依赖各自的一段历史也一起。

  // ── 左栏导航 + 网址（Task 10） ──────────────────────────────────────
  //
  // ★ 2026-10-08：这一摊（`view` / `go` / 后退前进 / 登录用户打开落地页的自动
  // 跳转 / 标签页标题）整段搬进 `app/useNav` —— 连"**不引路由库**"那条硬约束和
  // `go` 里两条 ⚠️（`window.history` 与 `replace`）也一起。这里只剩接线。
  const { view, go } = useNav({ checking, user })

  /** ★ 2026-10-10：拖/粘一张照片进来 = 换一张改（见 `usePhotoDrop`）。
   *  ⚠️ 它必须住在 `view` 定义**之后**（`active` 要读它）—— 往前挪一格就是
   *  TDZ（`Cannot access 'view' before initialization`），而且 typecheck 抓不到
   *  这种"声明顺序"问题，是渲染时当场炸（和拆 App 那轮踩的同一个坑）。 */
  const dropping = usePhotoDrop({
    active: view.kind === 'edit' && !!image && !busy,
    onDrop: onDropPhoto,
  })

  /**
   * ★ 2026-10-05：`lutOpenNext` 的清场（那个 ref 声明在上面 `lut` 那一段旁边）。
   *
   * **离开调色屏就清掉** —— 不清的话，以后每次点左栏「调色」都会替用户把那一栏
   * 拉开（那是他上一次从滤镜页过来时授权的"这一次"，不是"以后都这样"）。
   * ⚠️ 这条 effect 必须住在 `view` **后面**：写在 ref 那儿会踩 TDZ，整个 App 白屏
   *（`App.test.tsx` 163 条一起红，报错是一句 `Cannot access 'view' before initialization`）。
   */
  useEffect(() => { if (view.kind !== 'adjust') lutOpenNext.current = false }, [view.kind])

  // ★ 工具行只在调色屏；切走时把工具收掉 —— 不然回到调色屏时它还开着，
  //   而那时候照片可能已经换了（裁剪框会落在新照片上）。
  // ★ 2026-10-06（裁剪）：**裁剪的现场跟着一起收** —— 两个是同一个动作里设的，
  //   留下一个就是"框还在、工具没了"那种半截状态（回到调色屏时框会重新出现，
  //   而用户以为自己已经出去了）。
  useEffect(() => { setTool(null); closeCrop(); closeRetouch() }, [view.kind])

  /**
   * ★ 2026-10-05（滤镜，设计 §5 那三条入口里的第二条）：**离开「滤镜」那一页时**
   * 重新拉一次清单，顺手照一次镜子（`refreshLuts`，见 `app/useLutFlow`）。
   *
   * 为什么非要这一下：那一页上刚导入的滤镜要**立刻能用**、刚删的要**立刻消失**，
   * 而清单是 App 挂载时拉的那一份（`useLuts` 里那个 effect）—— 不重拉的话，
   * 用户回来看见的还是老清单：删掉的那个还亮着（点一下就送一个不存在的 id
   * 去落盘），新导的找不到。
   *
   * ⚠️ **判据是"从 luts 走到别的"这个边沿，不是"现在在不在 luts 上"**：写成
   * 后者的话，人一落到那一页就会拉一遍，而这趟拉回来的清单在那一页上根本没人看
   * （那一页自己管自己的清单）。上一条路由的旧值只能记在 ref 里 —— 放进 state
   * 就是多一个会吵起来的真相来源。
   * ⚠️ 依赖里放的是 `refreshLuts`（它自己盯着稳定的 `reloadLuts`），不是
   * `lutsApi` 那个每渲染新造的对象 —— 见 `useLutFlow` 里那段注释。
   */
  const wasOnLutsPageRef = useRef(false)
  useEffect(() => {
    const here = view.kind === 'luts'
    if (wasOnLutsPageRef.current && !here) void refreshLuts()
    wasOnLutsPageRef.current = here
  }, [view.kind, refreshLuts])

  // ★ 2026-10-08：原来下面还有两条 effect（登录用户打开落地页的自动跳转、
  //   标签页标题）—— 跟着 `view` / `go` 一起搬进 `app/useNav` 了。

  // 「后面还有 N 步」—— 确认条和点选条都用它（设计 §4.5）
  const curIdx = cursorId === null ? -1 : history.findIndex(s => s.id === cursorId)
  const futureSteps = curIdx >= 0 ? history.length - 1 - curIdx : 0

  /**
   * 滤镜那一包 props（★ 2026-10-08 收口）—— `ChatPanel` 和 `AdjustmentPanel`
   * 是**同一批东西、同一个来源**（`lutsApi` + `lut`），九个 props 原来一字不差
   * 抄了两遍；现在一份、两处展开。
   *   ⚠️ 两处的 props 名字和形状本来就一字不差（改一边就是改两边的契约）。
   *   ⚠️ `onNeedLutThumbs` 传的是**当下的** image / params（不是在 hook 里存一份）：
   *      缩略图要画的就是"用户此刻看到的这张照片、这套参数 + 那个滤镜"。
   */
  const lutPanelProps = {
    luts: lutsApi.luts,
    // ★ 2026-10-05 终审修复：清单到手没有（面板靠它区分"取不到"和"没有"）。
    lutsKnown: lutsApi.lutsKnown,
    lut,
    lutThumbs: lutsApi.thumbs,
    onPickLut: (id: number | null) => setLut(id === null ? null : { lutId: id, amount: 100 }),
    onLutAmount: (amount: number) => setLut((cur) => (cur ? { ...cur, amount } : cur)),
    onNeedLutThumbs: needLutThumbs,
    onGoImport: () => go({ kind: 'luts' }),
    onRetryLuts: () => void reloadLuts(),
  }

  /**
   * ★ 2026-10-10（「我的预设」）：存 / 改名 / 删 —— 三个都**先打服务端、成功再
   * 重拉**（`LutSettings` 的导入 / 改名 / 删除三处同一做法；本地不改名单 ——
   * 服务端会动名字（trim），名字的真值只有它那一份）。
   * ⚠️ 这里**不 catch**：失败那句话由 `PresetManager` 就地显示 —— `errorText`
   *   认服务端原话（重名那种错只有服务端说得清），在这一层再写一套判断的话，
   *   同一个毛病会长出两种说法。
   */
  const savePreset = async (name: string, p: Adjustments) => {
    await createPreset(name, p)
    await presetsApi.refresh()
  }
  const renamePresetTo = async (id: number, name: string) => {
    await renamePreset(id, name)
    await presetsApi.refresh()
  }
  const removePreset = async (id: number) => {
    await deletePreset(id)
    await presetsApi.refresh()
  }

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
      {/* ★ 2026-10-10：拖着一张照片悬在窗口上时的提示层（松手 = 换成它改）。
          它 `position: fixed` 全屏，摆在页面哪一层都一样（放最前面，读起来
          就是"先盖着、下面才是页面"）。 */}
      {dropping && <div className="drop-veil">松手，换这张照片</div>}
      {/* 左栏在**所有**界面里都在：作品页、详情页是同一个壳，换的只是右边那一格。
          ⚠️ 它**不收"有没有照片"那个参数**（2026-10-04 试过一版，被用户否掉：
          「微调的按钮要一直在」）—— 没照片时该变的是照片那块地方，见下面 `stage`。 */}
      <Nav view={view} onGo={go} />

      {/* 修图页和调色页**共用这一块壳**（★ 2026-10-04）。
          `adjust` 不是另一套界面：同一张照片、同一个舞台、同一根操作条 ——
          区别在**右边那一区**（对话 还是 微调面板），见下面 `workspace` 里那两处。
          ⚠️ 写成"两个 kind 一起渲染"而不是把整块复制一份：复制一份等于把
          "这张照片怎么排版"这件事变成两份，改一边忘一边是迟早的事。
          ⚠️ 也别顺手把面板挪到这个条件**外面**：挪出去，停在作品页 / 对话页
          时它也会跟着挂载 —— 而它是按"这张照片"来的东西，那些页面上照片根本不在。*/}
      {(view.kind === 'edit' || view.kind === 'adjust') && (
        <div className="app">
          {/* 顶上那三条横幅（通报 / 替换询问 / 存失败）—— ★ 2026-10-08 拆进
              `ui/Banners`（为什么是**三种东西、别合并**，那一段在组件文件头上）。 */}
          <Banners
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            asking={asking !== null}
            savedId={savedId}
            onAnswerAsk={answerAsk}
            saveFail={saveFail}
            onDismissSaveFail={() => setSaveFail(null)}
          />

          {!image && (
            <main className="stage">
              {/* ★ 还没有照片时，**两屏给的东西不一样**（2026-10-04 定的）：

                  · 「修图」= 欢迎页：标志 + 一句话 + 那条对话输入框 + 背景的图片球
                    —— 它是"**登录之后看到的第一张脸**"，要介绍这个产品是什么。
                  · 「调色」= 一句「还没有照片。」+ 一颗「选一张照片」
                    （`ui/AdjustEmpty.tsx`）—— 用户已经在这个工具里了，只是手上
                    这张没了，所以**不用再介绍一遍**。

                  ⚠️ 别让它们合并回同一个 —— 那正是 2026-10-04 用户撞上的那版：
                  他点「调色」，看到的是和「修图」**一模一样**的欢迎页，屏幕上
                  唯二的变化是左栏亮点挪了一格、地址栏多了一截，**看着就像没反应**。
                  他给的方子就是现在这条：「没有图片的时候显示图片的地方提示还没有照片」。

                  ⚠️ 左栏那一格**不跟着变**（`Nav` 不收这类参数）—— 变的是**这块地方**，
                  不是"这里有没有这件事"。两者分开才是他说的那个形状。 */}
              {busy ? <div className="hint">{busy}</div>
                : view.kind === 'adjust' ? <AdjustEmpty onPick={onPick} />
                  : <Uploader onPick={onPick} />}
            </main>
          )}

          {image && (
            <main className="workspace">
              {/* ★ 2026-10-05：预设栏 —— 照片**左边**那条（用户：「放在照片区域的
                  左侧」）。一格一张**用他这张照片现画**的效果小图，点一下整组套上。

                  ⚠️ 三个决定写在别处、这里只接线：
                    · 小图怎么画、什么时候作废 → `app/usePresetThumbs`；
                    · 哪一格亮着 → `core/presets` 的 `activePresetId`
                      （判全等、挂着滤镜时谁都不亮）；
                    · 长相 → `ui/PresetRail`。
                  ⚠️ 只在调色那一屏在（`view.kind === 'adjust'`）—— 别的屏旁边是
                  对话栏，没有它的位置；而它一挂上就画十三张小图，
                  挂错地方等于让对话页也白画一遍。 */}
              {view.kind === 'adjust' && (
                <PresetRail
                  image={image}
                  cube={lutsApi.cube}
                  activeId={activePresetId(params, lut !== null)}
                  // 展开拷贝：PRESETS 是模块级共享对象，直接传引用会让拖滑块改坏预设
                  // （和面板上原来那排药丸同一条理由）。
                  onPick={(p) => setParams({ ...p.adjustments })}
                  // 「原图」= 参数归零 **+ 滤镜也摘掉**（和面板那颗「重置」同一件事：
                  // 只归零参数的话，画面还是那套颜色，而用户以为按了"回到最初"）。
                  onClear={() => { setParams(ZERO); setLut(null) }}
                />
              )}
              <div className="stage">
                {/* ★ 2026-10-06（工具行）：照片上方那条带子（`ui/ToolBar`）——
                    「裁剪 / 对比」两颗工具，第二行（当前工具的控件）由它自己的
                    `children` 装（Task 4 把裁剪的塞进去）。
                    ⚠️ 只在调色屏（和预设栏、微调面板同一条判据）—— 修图屏那一条
                    位置是历史转盘（下面 `StepStrip`），两个屏各用一次这块地方。
                    ⚠️ 切走屏时要收掉工具，见顶上那条 `[view.kind]` 的 effect。 */}
                {view.kind === 'adjust' && (
                  <ToolBar active={tool} onPick={pickTool}>
                    {/* 第二行 = 当前工具的控件（★ 2026-10-08 拆成
                        `ui/CropControls` / `ui/RetouchControls` 两个组件，
                        DOM 一个字没改；各自的"长什么样、为什么这样"在组件文件头）。

                        ⚠️⚠️ **两个工具的第二行收在一条三目里**（2026-10-07 踩过）：
                        写成两个并排的 `&&` 时，React 的 children 会变成一个
                        `[false, false]` 的**数组** —— 数组永远 truthy，
                        `ToolBar` 那条"没有 children 就不画第二行"的判据当场失效，
                        开「对比」（两个都 false）也会长出一条空的第二行、
                        把照片推下去 37px。`App.test.tsx` 里那条
                        「★「对比」不算"工具开着"」正是它的守卫。 */}
                    {tool === 'crop' && crop && image ? (
                      <CropControls
                        image={image}
                        spec={crop.spec}
                        turns={crop.turns}
                        aspect={crop.aspect}
                        onPickAspect={pickCropAspect}
                        onTurns={setCropAngle}
                        onCancel={cancelCrop}
                        onDone={commitCrop}
                      />
                    ) : tool === 'retouch' && retouch && image ? (
                      <RetouchControls
                        image={image}
                        mode={retouch.mode}
                        radius={retouch.radius}
                        dirty={retouch.dirty}
                        erasing={erasing}
                        // 两个 setter 都照着原来那两句写：**改现场本身**（`setRetouch`
                        // 的 r 为 null 时原样返回 —— 工具已经收掉时的一次点击不该
                        // 凭空把它拉回来）。
                        onMode={m => setRetouch(r => (r ? { ...r, mode: m } : r))}
                        onRadius={radius => setRetouch(r => (r ? { ...r, radius } : r))}
                        onCancel={cancelRetouch}
                        onDone={commitRetouch}
                      />
                    ) : null}
                    {/* ★ 2026-10-06（对比）：它**不传 children** —— 一个开关没有
                        自己的控件，而空着的第二行会无端占掉照片 37px（开着对比时
                        照片整张跳一下，正好打在"放大着比细节"这个用法上）。
                        见 `ui/ToolBar` 顶上那段。 */}
                  </ToolBar>
                )}
                {/* ★ 2026-10-06（晚）：**历史转盘**（`ui/StepStrip`）——
                    照片上方那一圈（用户先画草图提的「对话区不留下照片了…
                    下方是当前图片，上方是可左右滚动的历史记录照片类似于 git
                    吧也就是回到那一步」，看完第一版平铺的时间轴又补了一句
                    「我画的是一种圆盘转动的感觉吧」；画板里三种转盘他挑了
                    **竖轴转盘**，画板会话 `.superpowers/brainstorm/398-1791272118`）。
                    它和对话区的关系是一次**搬家**：每一步的小图原来挂在对话
                    气泡下面，现在整圈挪到这儿。

                    ⚠️ 只在「修图」这一屏（`view.kind !== 'adjust'`）—— 和对话栏
                    同一条判据：调色那一屏是"拖滑块改"的界面区（用户 2026-10-04
                    的原话），那一屏的照片边上没有它。
                    ⚠️ 转起来/点一格 = `onJump`（和对话里「回到这一步」
                    **同一个函数**）—— 「跳转不删任何东西」那套契约一个字都不动。
                    ⚠️ `steps` 里的小图直接来自 `history`（客户端早为每一步画好了）
                    —— 这里一格都不新画、一分钱都不花。 */}
                {view.kind !== 'adjust' && (
                  <StepStrip
                    steps={history.map(s => ({ id: s.id, thumb: s.thumb, isOriginal: s.isOriginal }))}
                    currentId={cursorId}
                    generating={generating}
                    onJump={onJump}
                  />
                )}
                {/* params 直接传下去：[-100,100] → [-1,1] 的换算只发生在
                    TonePipeline.render 里（唯一入口）
                    ★ 2026-10-05（滤镜）：滤镜走**另外两个 prop**（`lutCube` /
                    `lutAmount`）—— cube 是一次性的纹理上传（只跟着 `lut` 变），
                    强度是每帧的 uniform。合成一个 prop 的话，拖强度就会连带
                    把 1MB 的 3D 纹理重传一遍（Canvas 那两个 effect 分得开，
                    是为这件事）。 */}
                <Canvas
                  image={image}
                  params={params}
                  lutCube={lutsApi.cube}
                  lutAmount={lut?.amount ?? 0}
                  canvasRef={canvasElRef}
                  originalPreview={originalPreview}
                  picking={picking}
                  marker={marker}
                  onPickPoint={onPickPoint}
                  onFail={noticeBad}
                  // ★ 2026-10-06（缩放）：**换了一张照片**的信号 —— 传的是
                  //   `sessionId`，`Canvas` 拿它当"该把放大镜收回适应窗口了"
                  //   的判据。⚠️ 传它不传 `image`：同一条会话里换步骤
                  //   （转盘跳一步、「再来一版」）图也换，但用户正对着同一块
                  //   地方前后对比 —— 那时候把视图拽回去等于把放大镜抢走。
                  // ★ 2026-10-06（工具行）：进**裁剪**先把视图收回「适应窗口」——
                  //   和"换会话"走同一条路（`resetKey` 是 dep，值一变就归位）。
                  //   值必须**按值稳定**（字符串），别传对象/数组（每渲染一次都是新身份）。
                  // ★★ 2026-10-06（对比裁定）：这里只认**裁剪**。对比是个开关，
                  //   用户多半正放大着才去按它 —— 进对比就把视图拽回「适应窗口」
                  //   正好毁掉"放大着比细节"这个用法（spec §3.3 要的是两张图同步缩放）。
                  resetKey={`${sessionId ?? ''}:${toolIsModal ? 'crop' : ''}`}
                  viewLocked={toolIsModal}
                  // ★ 2026-10-06（裁剪）：框 + 预览那一帧的现场。没在裁时是 null
                  //   —— 那时画布上一个内联样式都不留（和"适应窗口"那一帧同一条规矩）。
                  crop={cropScene}
                  // ★ 2026-10-06：生成中给照片盖一层淡淡的暗罩 + 转圈（那十几秒
                  //   照片原来完全没反应）。传的是 `generating` 不是 `busy` ——
                  //   「正在思考」/上传/切会话那几句**不盖**（一闪一暗会闪），
                  //   判据在 App 顶上那一条。
                  // ★ 2026-10-07（点修）：**擦除也可能慢**（大块要几秒，见
                  //   `ERASE_VEIL_PIXELS`）——慢的那一档也盖同一层暗罩，
                  //   小斑块（毫秒级）不盖，免得闪。
                  busy={generating || erasing}
                  // ★ 2026-10-06（对比，spec §3.3）：开关 + 那份够清楚的原图 +
                  //   右下角那排里那颗的回调。⚠️ 原图**不在**这里备（懒做在 App
                  //   顶上那条 effect 里）；备的路上 `compareWith` 就是 null，
                  //   照片上安安静静，一颗都不画错。
                  comparing={comparing}
                  compareWith={compareSrc}
                  // ★ 2026-10-07（设计评审）：调色屏上「对比」**只留工具行那一颗**。
                  //   10-06 那批本来有意做"两处入口、一个状态"，真机一看是**同一
                  //   开关的两种长相并排**（工具行的格子 + 这排的按钮，还会一起
                  //   点亮），读起来像两个功能 —— 用户拍板"去掉一个"。
                  //   判据放这儿而不是删 ToolBar 那颗：工具行是这一屏的主入口，
                  //   而**修图屏没有工具行** —— 那一屏这颗照旧在，两屏各一个入口。
                  //   ⚠️ 只藏按钮：`comparing` / `compareWith` 照传，工具行那颗
                  //   点开的分屏在这一屏照样画得出来。
                  onCompare={view.kind === 'adjust' ? undefined : toggleCompare}
                  // ★ 2026-10-07（点修）：涂抹的现场（笔刷 + 掩码本体）。
                  //   ⚠️ 它**不动 `resetKey` / `viewLocked`** —— 点修要的就是
                  //   "放大着修细节"（和「对比」同一条裁定：把视图拽回适应窗口
                  //   正好毁掉这个用法）。手势的停用由涂抹层自己盖住照片区完成。
                  retouch={retouchScene}
                />
                {/* ★ 2026-10-08（用户原话：「给调色界面添加上一步下一步的箭头
                    回溯按钮，但是这个是不跟对话区联动的 —— 相当于一个宏观
                    一个微观」）：照片**左下角**那组「上一步 / 下一步」。

                    宏观 = 修图屏那圈历史转盘（一眼看全**版本**）；微观 = 这一组
                    —— ★ 2026-10-08（账本落地后分工定死）：它翻的是**当前这一版
                    自己的账本**（这一版上改过的每一笔：调色 / 滤镜 / 裁剪 / 点修），
                    "第几笔 / 共几笔"。位置显示走 `ledgerTotal` / `past.length`
                    —— 和 `core/ledger.ts` 的口径**必须**是同一个（那边是唯一的账本）。

                    ⚠️ **和对话区没有关系**是用户点名的：翻账本走的是 `ledgerStep`
                    —— 一条消息都不产生、一步都不切、一分钱不花，连"站的位置"
                    （`cursorId`）都不动。`App.test.tsx` 有一组用例钉着这些。

                    ⚠️ **只在调色屏**（和预设栏、工具行、微调面板同一条判据）：
                    修图屏那块地方是转盘，两个同一屏里并排就是同一件事两个开关。
                    ⚠️ **账本只有一笔时不画**（刚上传 / 没动过）—— 不留一组按不动的按钮。
                    ⚠️ **正在裁剪 / 点修时收起来**：那两个是"在这张图上干活"的
                    模态工具（框 / 涂抹都按当前这版算），翻一笔会把用户的活儿
                    留在原地、换个底子接着算 —— 「对比」不算（那正是比版本的时候）。
                    ⚠️ 位置是**镜像 `.zoom-bar`**（右下角那排缩放）：同样离照片
                    那圈相纸边 `--sp-3`，所以 CSS 里那两个 offset 是
                    `舞台内边距 + --sp-3` —— 动 `.stage` 的内边距要连着看。 */}
                {(() => {
                  const cur = history.find(s => s.id === cursorId)
                  const total = cur ? ledgerTotal(cur) : 1
                  if (view.kind !== 'adjust' || !image || !cur || total <= 1) return null
                  if (tool === 'crop' || tool === 'retouch') return null
                  // 位置走 `ledgerIndex`（`past.length + 1`）—— **唯一**那份口径，
                  // 别在这儿再数一遍（数法一旦和 `core/ledger.ts` 分家就是"两处各
                  // 说各话、谁也不报错"）。
                  return (
                    <StepNav
                      index={ledgerIndex(cur)}
                      total={total}
                      onPrev={() => ledgerStep(-1)}
                      onNext={() => ledgerStep(1)}
                    />
                  )
                })()}
                {/* ★★ 2026-10-09：**「这张照片怎么办」那三颗搬到这儿了** ——
                    舞台底下那条灰色的操作条（用户原话：「**这一行不要了，放在
                    照片下面的灰色地带**」）。原来是修图页最顶上那一条，今天整条
                    撤掉（见 `TopActions` 的文件头）。
                    ⚠️ 它**必须住在 `.stage` 里面**：带子那三个负外边距的贴边
                    （顶穿左右内边距、顶穿底下那圈 `--stage-gap`）全靠
                    `.workspace .stage > .stage-bar` 那条选择器 —— 挪到外面它就
                    变成一条浮在照片区中间、四周露着深边的灰条。
                    ⚠️ 改那三颗按钮的**文字**要连带改探针/测试（理由在组件里那段）。 */}
                <TopActions
                  canShare={canShare}
                  delivering={delivering}
                  onShare={onShare}
                  onDownload={onDownload}
                  onSave={onSave}
                  onNew={startNew}
                  busy={busy !== null}
                />
              </div>
              {/* ★ 2026-10-04：**调色那一屏没有对话栏。**

                  用户看完第一版（面板在底下开着、对话还杵在右边）说：
                  「**调色就是对图片微调的界面区不是对话区**」——
                  他把界面上这两块看成两个**区**：修图页是对话区（说话改），
                  调色那一屏是微调区（拖滑块改）。两个区同时摆在眼前，
                  调色那一屏读起来仍然是"对话页底下多了条东西"。

                  ⚠️ **这条规矩窄屏上早就有了**（`styles.css` 里那条
                  `.app:has(> .panel) .chat { display: none }` 在的地方）——
                  当时只对手机生效，因为那边是三样东西抢竖向空间。现在是同一个
                  道理放到所有屏上，所以那条 CSS **已经删了**（见它原来那处的注释）。

                  ⚠️ 代价记在这儿：对话输入框是**非受控**的（`defaultValue` +
                  `key={draft}`，见 ChatPanel 里那段），所以在这一屏切走时
                  **打在输入框里还没发出去的那半句会没**。接受它的理由是
                  这一屏本来就不是打字的当口 —— 真想说话，点左栏「修图」就回去了，
                  而消息、历史、照片这些**归 App 管的**一样都不丢。

                  判据是 `view.kind`，不是"面板开没开"：面板开着的**唯一**地方
                  就是这一屏（见上面 `view.kind === 'adjust'` 那条），所以
                  这一个条件已经把 "有没有 .chat" 和 "有没有 .panel" 绑成同一件事。 */}
              {view.kind !== 'adjust' && (
                <ChatPanel
                  messages={messages}
                  cards={cards}
                  busy={busy}
                  suggesting={suggesting}
                  draft={draft}
                  onSend={send}
                  onStop={stopGeneration}
                  onAskSuggest={onAskSuggest}
                  // ★ 2026-10-10：这两对是「等待要诚实」那批 ——
                  //   `generating`（这份文件上面那个 `busy === BUSY_GENERATING`）
                  //   决定那一格是「停止」还是禁用的「发送」；
                  //   `retryId` / `onRetry` 是生成失败后的「再试一次」。
                  generating={generating}
                  retryId={retryId}
                  onRetry={retryGeneration}
                  onCard={onCard}
                  // ★ 2026-10-06（晚）：`onJump` 和 `currentId` 两个 prop 撤了 ——
                  //   对话里那两颗文字提示（「回到这一步」/「你在这里」）随用户
                  //   一句「那这些文字提示就可以不要了」一起退役：转盘上已经
                  //   写着"你在哪、回到哪一版"了（`StepStrip` 拿的还是这个 `onJump`）。
                  onRerun={onRerun}
                  // 只有"记着当初那句话"的步骤才给「再来一版」——
                  // 原图没有那句话（`prompt` 缺席），所以它那颗按钮不会出现。
                  rerunnable={history.filter(s => s.prompt).map(s => s.id)}
                  jumpableIds={history.map(s => s.id)}
                  // ★ 2026-10-06（晚）：`thumbs` 这个 prop 撤了 —— 每一步的小图
                  //   现在挂在照片区上方那条时间轴上（`ui/StepStrip` 拿的是
                  //   `history` 里同一份小图），对话区里不再有照片。
                  // ★ 2026-10-06：单条记录的删除。`originalId` = 「原图」那一步
                  //   的消息 id（欢迎语和它是同一条）—— 那一条上**不摆** ✕：
                  //   它是这条会话的锚（删了它，这一屏就没有落脚的地方了）。
                  originalId={history.find(s => s.isOriginal)?.id ?? null}
                  onDeleteMessage={onDeleteMessage}
                  // ★ 2026-10-06 下午：选择模式里一次勾好几条那条路（同一本账）。
                  onDeleteMessages={onDeleteMessages}
                  // ★ 2026-10-09：对话栏顶上那一行 —— 这条会话叫什么 + 一颗铅笔。
                  //   名字走 `sessionTitle()` 那**唯一**一份三级退口径（和对话列表
                  //   同一份）；没有会话时是 null，那一条整个不画。
                  //   ⚠️ `canRename` **不是** `title !== null`：上传之后名字当场
                  //   就有（先用文件名顶着），而会话 id 要等建会话那趟回来 ——
                  //   那一段窗口里点铅笔会静默失败，所以那时**不摆**那颗按钮。
                  title={sessionName ? sessionTitle(sessionName) : null}
                  canRename={sessionId !== null}
                  onRename={(next) => void renameSession(next)}
                  // marker 非空必然 picking 为真（两者出自同一个对象），所以这里
                  // 不必再 or 一次 —— 从 `pending` 推出来的东西不可能互相打架。
                  marking={picking}
                  canConfirmMark={!!marker && !!pendingText}
                  onConfirmMark={confirmMark}
                  onCancelMark={cancelPick}
                  // ★ 2026-10-05（设计 §4.5/6.1）：后面还有几步 + 那条"要切掉
                  //   后面吗"的确认条。（"站的位置"那一项 2026-10-06 晚撤了 ——
                  //   只有转盘还用得着 `cursorId`，它就在上面。）
                  futureSteps={futureSteps}
                  replacing={pendingReplace !== null}
                  onConfirmReplace={confirmReplace}
                  onCancelReplace={declineReplace}
                  // ★ 2026-10-05（滤镜，Task 9）：对话区这几颗和微调区那一栏
                  //   是**同一批东西、同一个来源**（`lutsApi` + `lut`）——
                  //   ★ 2026-10-08：九个 props 收成了一份 `lutPanelProps`
                  //   （原来两处一字不差各抄一遍），展开即可。
                  {...lutPanelProps}
                />
              )}

              {/* ★ 2026-10-05：微调面板**搬进右边这一格**（原来在图片区下面）。
                  用户原话：「图片区和微调区左右分布吧，然后调色整个区域的功能布局
                  优化一下看怎么不拥挤和用户使着方便」—— 他挑的是"图片占大块、
                  微调一条列在右"那版（画板上过的方案 A）。
                  ⚠️ 它和对话栏**永远不同屏**（判据都是 `view.kind`：这一屏不渲染
                  对话、别的屏不渲染面板），所以两栏合穿同一格是安全的 ——
                  这一格里要么是对话，要么是微调，不会两个都来、也不会两个都空。
                  ★ 这一条判据是**从网址推出来**的（不是 state）：
                  在那之前它是 `const [showPanel, setShowPanel] = useState(false)`，
                  由顶栏那颗按钮翻转 —— 再留一份 state 就是同一个事实有两个可以
                  互相打架的答案（停在 `/app/adjust` 上按 F5，state 回到 false、
                  地址栏却还写着 adjust）。由网址推顺带换来：**按 F5 面板还开着**、
                  这一屏能被收藏、能发给别人。
                  ⚠️ 别把这条判据改回 state：`view` 是**页面刷新之后仍然对**的那一份，
                  state 不是 —— 而这个项目已经在这条线上栽过一次（见 Nav.tsx 里
                  「产品介绍」那颗的注释：参数必须留在网址里，不能只记在内存）。*/}
              {view.kind === 'adjust' && (
                <AdjustmentPanel
                  value={params}
                  onChange={setParams}
                  // ★ 2026-10-05：从「滤镜」那一页按「去调色里套一张」过来的那一趟，
                  //   这一栏**进来就是开着的**（见 `lutOpenNext` 那段）。
                  defaultLutOpen={lutOpenNext.current}
                  // ★ 2026-10-05（滤镜）：「重置」= 参数归零 **+ 滤镜也清掉**。
                  //   只归零参数的话，用户按了重置、画面还是那套颜色（滤镜是
                  //   另一条路，不归 params 管），而面板上那格还亮着 —— 他会以为
                  //   是重置坏了。
                  onReset={() => { setParams(ZERO); setLut(null) }}
                  onMatchReference={file => void matchReference(file)}
                  onMatchWork={w => void matchWork(w)}
                  // ★ 2026-10-10（「我的预设」）：清单四态 + 存/改名/删三个动作
                  //   （见上面那三个回调）。面板只摆样子 —— 和滤镜那一包同一条分层。
                  presets={presetsApi.presets}
                  presetsKnown={presetsApi.known}
                  onSavePreset={savePreset}
                  onRenamePreset={renamePresetTo}
                  onDeletePreset={removePreset}
                  // ★ 2026-10-05（滤镜，设计 §5.2）：面板只摆样子，状态和副作用
                  //   全在 App / `useLuts` 那边。
                  //   ★ 2026-10-08：九个 props 和对话区那份是**同一份**
                  //   （`lutPanelProps`，展开即可 —— 原来两处一字不差各抄一遍）。
                  {...lutPanelProps}
                />
              )}
            </main>
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
          // ★ 2026-10-10：生成中切会话的**事前拦截**（那一版还在算，切走就白算了）
          //   —— 判据就是这份文件顶上那个 `generating`。
          generating={generating}
        />
      )}
      {view.kind === 'gallery' && <GalleryPage onOpen={(id) => go({ kind: 'work', id })} />}
      {view.kind === 'work' && (
        <WorkDetailPage
          id={view.id}
          onBack={() => go({ kind: 'gallery' })}
          canApply={image !== null}
          onApply={(p, recipeLut) => {
            // ★ 裸调，和滑块 / 预设 / 重置**同级** —— 改 params 从来不 push 快照，
            //   「套用」也不该是例外（裁定 ⑤）。快照是给"生成式编辑"用的。
            setParams(p)
            // ★ 2026-10-05（滤镜，T12）：滤镜按**名字**找回清单里那一个
            //   （配方里只存名字 —— id 对已经烤好的图没有意义，见 shared/works.ts）。
            //
            // ★★ 这一格是**替换**，不是合并（2026-10-05 审查）：params 是整体换、
            //   命中时连 id 带强度一起换 —— 滤镜那一格就必须由这张作品的配方
            //   **唯一决定**。miss 还留着手上一层的话，"套用"少决定了这一格：出来的
            //   是个两边都不是的混合体（作品那套**在黄昏下调出来的**参数 + 手上那个
            //   无关的夕阳），话（"这次只套了调色"）和屏幕（还亮着一层颜色）打架，
            //   而且套完再存一次，那个无关的滤镜会被悄悄写进新作品的配方。
            //   这也是仓库既有的规矩（`dropGoneLut`）：不存在的滤镜不留在手上。
            const hit = recipeLut
              ? lutsApi.luts.find((l) => sameLutName(l.name, recipeLut.name))
              : undefined
            if (recipeLut && !hit) {
              // 已经被删了 → **只套调色，并把这件事说出来**（不说就是悄悄少了半套）。
              noticeBad('那张作品用的 Lut 已经删了，这次只套了调色。')
            }
            setLut(hit && recipeLut ? { lutId: hit.id, amount: recipeLut.amount } : null)
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
          // ★ 2026-10-09：改名成功之后把新的那份 user 换进来 —— `user` 是
          //   **App 的 state**（这一页只是看一眼），名字得有一个来源。
          onUserChanged={setUser}
        />
      )}
      {/* 模型设置（§7.4，Task 9）。*它自己不拉名单之外的东西* ——
          这一页要用的清单（几套配置、哪套在用）全从 `/api/models` 来，
          不进 App 这层状态：那是"设置"，不是修图现场，别让两处各存一份。 */}
      {view.kind === 'models' && <ModelSettings />}
      {/* 滤镜（★ 2026-10-05，设计 §5.1）：设置里的第 4 格点进来就是它。
          和「模型」同一条：这一页的清单**自己拉自己管**，不进 App 这层状态 ——
          那是"设置"，不是修图现场，别让两处各存一份。
          ⚠️ **不给它 `onBack`**：它和「模型设置」同一层，那一页也没有返回
          （左栏一直在，出去走左栏就是了）—— 两页的走法不该长成两个样子。
          ⚠️ 出去时**重拉一次清单**是上面那个 effect（看 `view.kind` 的边沿）干的，
          不在这句 JSX 里；`LutSettings` 这边只管自己那一份。 */}
      {view.kind === 'luts' && (
        <LutSettings onUse={() => { lutOpenNext.current = true; go({ kind: 'adjust' }) }} />
      )}
    </div>
  )
}
