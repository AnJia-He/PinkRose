import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import ChatPanel, { type ChatMessage } from './ui/ChatPanel'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { resizeBitmap } from './image/resize'
import { fitToLimit, probeLimit } from './render/limits'
import { applyDeltas, ZERO, type Adjustments } from '../shared/adjustments.ts'
import { buildExportBlob, buildFilename, canShareImage, downloadImage, shareImage } from './export/save'
import { prepareForModel, prepareForRouting, type Sizable } from './image/prepare'
import { ApiError, postEdit, postRoute, postSuggest } from './api/client'
import { bitmapsToClose, attachThumb, jumpTo, pushSnapshot, type Snapshot } from './core/history'
import { makeThumbnail } from './core/thumbnail'
import { markImage, type NormPoint } from './image/mark'
import type { RouteDecision, SuggestCard } from '../shared/protocol.ts'

/**
 * 建议卡片最多等这么久。
 *
 * `/api/suggest` 最坏会占住后端串行队列约 4 分钟（上游挂掉时队列重试 4 次、
 * 每次超时上限 60 秒），而拉卡片是上传后用户盯着看的第一个动作。跨任务裁定：
 * **不在后端特例化**（那会削弱队列统一的重试契约），改由前端不阻塞——
 * 超过这个时间就把用户放进对话，卡片晚到就晚到、不来就算了。
 */
const SUGGEST_WAIT_MS = 10_000

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
  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  const [showPanel, setShowPanel] = useState(false)
  /** 非 null 时既是"正在忙"的标志，也是要显示给用户的那句话 */
  const [busy, setBusy] = useState<string | null>(null)
  /** 正在导出的是哪一个按钮（null = 没在忙）。两个按钮共用一个"忙"，
   *  但只有被按的那个显示「准备中…」—— 两个一起变会像出了两件事。 */
  const [delivering, setDelivering] = useState<'share' | 'save' | null>(null)
  /** 本设备能不能把图交给系统分享面板。只在挂载时算一次：设备能力不会中途变。
   *  用惰性初始化（传函数），免得每次 render 都去 new 一个探针 File。 */
  const [canShare] = useState(canShareImage)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cards, setCards] = useState<SuggestCard[]>([])
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

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const originalFileRef = useRef<File | null>(null)
  const idRef = useRef(0)
  /** 每次选图 +1。晚到的卡片结果靠它对号，免得贴到下一张照片上。 */
  const pickIdRef = useRef(0)
  /** 用户**这一趟说过的原话**（send / 卡片各写各的）。
   *  模型说拿不准时要把它留到用户点完图 —— 届时"原来那句话"是**那一刻**的那句，
   *  不是某个 state 里可能已经翻篇的那句。 */
  const pendingRef = useRef<string | null>(null)

  const nextId = () => ++idRef.current

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
    setBusy('正在改…大约 10 秒')
    try {
      // source 直接就是能 drawImage 的东西（位图或画布），不用再拆一层
      const prepared = await prepareForModel(source)
      const out = await postEdit({
        imageDataUrl: prepared.dataUrl,
        editPrompt,
        width: prepared.width,
        height: prepared.height,
      })
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

      setHistory(prev => {
        const next = pushSnapshot(prev, {
          id: messageId, label: '生成式编辑',
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
      // 失败时用户的参数一点都不丢（spec §4.7 的铁律）。
      // 只加一句提示，绝不去动 params。
      console.error(e)
      say(e instanceof ApiError ? e.message : '这次没改成功，再试一次？')
    } finally {
      setBusy(null)
    }
  }, [say])

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
   */
  const loadCards = useCallback(async (img: DecodedImage, pickId: number) => {
    try {
      const preview = await prepareForRouting(img.bitmap)
      const s = await postSuggest({ imageDataUrl: preview.dataUrl })
      // 晚到的那份属于上一张照片就丢掉——否则看第一张时发出的请求回来时
      // 会贴到第二张照片上。用原图而不是画布：此刻 params 还是全零，
      // 两者本就一样，直接用原图省掉一次"画布到底挂上了没"的竞态。
      if (pickIdRef.current === pickId) setCards(s.cards)
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

      // 原图自己也算一步，挂在欢迎语那条消息上 —— 这样「回到这一步」
      // 能回到最开始，撤销第一次生成时特别有用。
      const welcomeId = say('准备好啦，说说想怎么改？')
      // 缩过就得说。紧跟欢迎语，用户往下看第一眼就撞上，不会滑过去。
      if (note) say(note)
      setHistory([
        { id: welcomeId, label: '原图', base: img, params: ZERO, isOriginal: true, thumb: '' },
      ])

      // 卡片是**可选件，绝不能让用户等它**：最多等 10 秒（见 SUGGEST_WAIT_MS），
      // 超时就走人。竞速的另一半不会抛（loadCards 自己吞掉错），
      // 所以超时之后它还在后台跑，回来了照样把卡片贴上。
      setBusy('正在看你的照片…')
      const myPick = ++pickIdRef.current
      await Promise.race([
        loadCards(img, myPick),
        new Promise(resolve => setTimeout(resolve, SUGGEST_WAIT_MS)),
      ])
    } catch (e) {
      console.error(e)
      alert('这张图打不开，换一张试试')
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
      say('好啦，看看这样行不行。')
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

  // 导出：画布尺寸就是当前 base 的尺寸。调色不缩图（spec §4.4）。
  //
  // 用户在真机上跑完 30 秒那条线后的原话：「下载后用户第一时间是不知道在哪里的」
  // —— 时间够了，但那一段让人心里没底。所以能分享的设备多给一个「分享」：
  // 点一下弹系统面板、一步选微信，跳过"翻文件管理器找图"。
  //
  // **两个按钮各传各的**，不做"能分享就一律分享"：用户明确说过有时候就是
  // 不想分享（「那有时候不想立即分享也得分享喽」）。分享失败才退回下载 ——
  // 用户点的是"把图给我"，分享只是其中一种给法，失败不该让他两手空空。
  const deliver = useCallback(async (wantShare: boolean) => {
    const canvas = canvasElRef.current
    const file = originalFileRef.current
    if (!canvas || !file) return
    setDelivering(wantShare && canShare ? 'share' : 'save')
    try {
      const blob = await buildExportBlob(canvas, file, 'image/jpeg', 0.95)
      const name = buildFilename(file.name, 'image/jpeg')
      if (!wantShare || !canShare) {
        downloadImage(blob, name)
        return
      }
      try {
        await shareImage(blob, name)
      } catch (e) {
        // 分享真的失败了（没权限、系统拒绝）。退回下载，至少让他拿得到图。
        // 用户自己取消**不会**走到这儿 —— shareImage 把取消当成正常结束。
        console.error(e)
        downloadImage(blob, name)
      }
    } catch (e) {
      console.error(e)
      alert('保存失败，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [canShare])

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

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">RuiXing</span>
        {image && (
          <div className="actions">
            <button onClick={() => setShowPanel(v => !v)}>微调</button>
            {/* 不能分享的设备上这个按钮**干脆不出现**：桌面 Chrome 有
                navigator.share 但不认图片，留一个点了弹不出东西的按钮更糟。
                它不出现时，「保存」顶上当主按钮。 */}
            {canShare && (
              <button className="primary" onClick={() => deliver(true)} disabled={delivering !== null}>
                {delivering === 'share' ? '准备中…' : '分享'}
              </button>
            )}
            <button
              className={canShare ? '' : 'primary'}
              onClick={() => deliver(false)}
              disabled={delivering !== null}
            >
              {delivering === 'save' ? '准备中…' : '保存'}
            </button>
          </div>
        )}
      </header>

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
            />
          </div>
          <ChatPanel
            messages={messages}
            cards={cards}
            busy={busy}
            onSend={send}
            onCard={onCard}
            onJump={onJump}
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
  )
}
