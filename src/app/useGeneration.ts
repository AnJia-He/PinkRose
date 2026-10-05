import { useCallback, useRef } from 'react'
import { applyDeltas, type Adjustments } from '../../shared/adjustments.ts'
import { sameLutName, type LutMeta, type LutRef } from '../../shared/lut.ts'
import type { RouteDecision, SuggestCard } from '../../shared/protocol.ts'
import { ApiError, isAbort, isUnauthorized, postEdit, postSuggest } from '../api/client'
import { bitmapsToClose, cutAfter, pushSnapshot, type Snapshot } from '../core/history'
import type { DecodedImage } from '../image/decode'
import { prepareForModel, prepareForRouting, type Sizable } from '../image/prepare'
import type { ChatMessage } from '../ui/ChatPanel'

/**
 * **「这句话该怎么改」到「花钱改一版」**那一整件：助手开口、路由决策、
 * 生成式编辑、停止、建议卡片。
 *
 * 2026-10-03 从 `App.tsx` 里整段搬出来的（原文照搬，注释一条没丢）——
 * 它在那边原本是 `say` / `runGenerate` / `stopGeneration` / `applyDecision` /
 * `loadCards` 连续的一百多行，而这一百多行说的是同一件事：
 * **一轮对话怎么变成一次真实的改动**。
 *
 * ⚠️ **搬的时候依赖数组一个都没改。** 这个文件原来那几段注释反复警告的就是
 *    这件事（`applyDecision` 里那句"漏了它，这个回调会永远捕获第一次 render 的
 *    image，而且是静默的"）—— 看着"多一项少一项无所谓"就是下一次静默失灵的开始。
 *    带进来的那几样里，`baseSeq` / `pendingRef` / `idRef` 都是 **ref**（身份稳定），
 *    所以原来写 `[]` 的那几条依旧写 `[]`。
 */

export type GenerationDeps = {
  /** 当前底图。生成送的是**它**（不是原图、也不是画布），见 `runGenerate`。 */
  image: DecodedImage | null
  setImage: (img: DecodedImage) => void
  /** 当前参数。参数那半立刻生效（本地、免费），生成那半只把它当**文本上下文**。 */
  params: Adjustments
  setParams: (p: Adjustments) => void
  /**
   * 当前滤镜（★ 2026-10-05）。**它只服务"就是此刻"那两条路**（`send` / 卡片
   * 触发的 `applyDecision` —— 那两条传的是"现在手上这个"）。
   *
   * ⚠️ **推快照时用的不是它**：`runGenerate` 的 `lutAtStep` 是**传参**进去的
   * （和 `paramsAtStep` 并列）。「再来一版」正是靠这一点才记对 —— 它先跳转、
   * 再在同一次调用里重掷，读闭包就会记成跳转前那个（2026-10-05 复审抓到的）。
   * 别把这两条路又合并回"读一个闭包"。
   */
  lut: LutRef | null
  /**
   * 换滤镜（★ 2026-10-05 T11）：对话那条路把 `decision.lut` 落进 App 的 `lut` 状态。
   * **不推快照** —— 和 `setParams` 同一个级别（裁定 ⑤）。
   */
  setLut: (l: LutRef | null) => void
  /**
   * 滤镜清单（★ 2026-10-05 T11）：用来把模型给的名字**换成 id**。
   * 对号用 `sameLutName`（trim + 忽略大小写）—— 和「照调」、设置页同一把尺子。
   */
  luts: LutMeta[]
  /** 底图换到第几版了（上传 +1、每次生成 +1）。它是"这一版还算不算数"的闸门。 */
  baseSeqRef: { current: number }
  /** 消息号发号器（和 App 那边共用同一个计数器 —— 快照要对得上号）。 */
  idRef: { current: number }
  /** 忙的标志**留在 App**：它不止管生成（上传、切会话也用它），是全站的一个灯。 */
  setBusy: (s: string | null) => void
  /** 票中途失效 → 回登录页。 */
  setUser: (u: null) => void
  noticeBad: (text: string) => void
  /** 建议卡片：换了底图、或者开始生成，那批卡片就作废。 */
  setCards: (c: SuggestCard[]) => void
  /** 模型说拿不准时，请用户在图上点一下。 */
  setPending: (p: { text: string; marker: null; keepFrom: number }) => void
  /** ★ 2026-10-05（设计 §4.5）：从旧步骤生成时挂确认条（App 的 setState）。 */
  setPendingReplace: (p: { stepId: number; editPrompt: string; reply: string; keepFromMsg: number }) => void
  /** 用户**这一趟说过的那句原话**（点选兜底要留到确认那一刻）。 */
  pendingRef: { current: string | null }
  setMessages: (fn: (m: ChatMessage[]) => ChatMessage[]) => void
  /** 推一步快照（生成那一步要挂上去，「回到这一步」靠它）。 */
  setHistory: (fn: (h: Snapshot[]) => Snapshot[]) => void
  /**
   * ★ 2026-10-05：现在站在哪一步（`cursorId`）+ 最新一步的 id（`tipId`）。
   * 前者是切口的切点、后者判"要不要先问一句"（Task 4）。都**必须进依赖数组**：
   * 它们变了（跳转）而回调还在用旧值时，切口会切错位置 —— 不报错的那种错。
   */
  cursorId: number | null
  tipId: number | null
  /** 推完新步把"站的位置"挪过去（新那步就是新的最新）。 */
  setCursorId: (id: number) => void
}

export function useGeneration(deps: GenerationDeps) {
  const {
    image, setImage, params, setParams, lut, setLut, luts, baseSeqRef, idRef, setBusy, setUser,
    noticeBad, setCards, setPending, setPendingReplace, pendingRef, setMessages, setHistory,
    cursorId, tipId, setCursorId,
  } = deps

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
   * ★ 2026-10-05（滤镜）：`lutAtStep` 和 `paramsAtStep` 是**同一类东西** ——
   * "这一步是从哪个状态走出来的"。它也**必须显式传**，理由和 `source` 一模一样，
   * 而且比 `source` 更隐蔽：`onRerun` 是**先 `onJump(id)`、再在同一个处理器里**
   * 调进来的，而 `onJump` 里那个 `setLut` 是 state 更新、这一轮渲染里不生效 ——
   * 读闭包的话，从带滤镜的旧步骤重掷，新那一步记的就是**跳转前**手上那个滤镜
   * （`params` 靠传参躲过了这条，滤镜当初没传，于是它踩了个正着）。
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
    lutAtStep: LutRef | null, source: Sizable,
    /**
     * ★ 2026-10-05：这一版是从哪长出来的 —— 切口的**切点** + 切对话时
     * "从哪条消息起保留"（设计 §4.2/4.3）。
     *
     * ⚠️ **必填、不读 state**：理由和 `paramsAtStep` / `lutAtStep` 一字不差
     *   ——「再来一版」是**先跳转、再在同一个 tick 里**调进来的，读 `cursorId`
     *   那个 state 拿到的是**跳转前**的值。每个调用点被编译期逼着表态。
     */
    origin: { stepId: number; keepFromMsg: number },
  ) => {
    if (!editPrompt) return
    // ★ 一次生成 = 一个 controller。「停止」按的就是它（见 stopGeneration）。
    const ac = new AbortController()
    editAbortRef.current = ac
    // ★ 这一次生成是**冲着哪一版底图**去的。十几秒里用户完全可能切走（左栏「对话」
    //   里点开一条、或者按「新的一张」），而那时候这一版的结果**不许再往下写** ——
    //   写下去就是把它塞进**另一条会话**的 history（那条对话凭空多一步、屏幕上换成
    //   这张照片），紧接着被落盘那一趟写进那条会话：两条会话互相污染，一句报错都没有。
    //   钱已经花了，但写错地方更坏（§9 那三条"错了不会报错"里就有"串会话"）。
    const seqAtStart = baseSeqRef.current
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
      // 用户切走了（切会话 / 新的一张都会推 `baseSeqRef`）—— 这一版作废。
      // ⚠️ 位图要还回去，别漏在内存里；而且**要留痕**：钱花了、东西没给，
      //   静默扔掉是这个项目最恨的那种失败。
      // ★ 2026-10-01（Task 6 评审）：光在控制台留痕不够 —— 用户在屏幕上**什么都
      //   看不到**，只会觉得"我说了句话，什么都没发生"。这一刻他在另一条会话上，
      //   所以这句通报要**说清是哪一次、怎么回事、还能怎么办**（§5：哪不对+怎么办），
      //   而且不许许诺"钱没花"这种我们做不到的事。
      if (baseSeqRef.current !== seqAtStart) {
        bitmap.close()
        console.error('生成回来时用户已经切走了，这一版不写进去（钱已经花了，但写进别的会话更坏）')
        noticeBad('你切走时，刚才那次生成还没回来 —— 结果没写进去。要的话，再说一遍。')
        return
      }
      const nextBase: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height }
      // 底图换了一版 —— 上传时那批建议卡片从这一刻起作废（见 loadCards）。
      baseSeqRef.current++

      setHistory(prev => {
        // ★ 2026-10-05（切口）：从 `origin.stepId` **之后**的步骤全部切掉（含）。
        //   放在这里（= 生成**成功之后**、和推新步同一个 updater）不是随手的：
        //   失败和「停止」都在前面 `return` 掉了 —— 花了一次没成，后面的不该陪葬。
        const next = pushSnapshot(cutAfter(prev, origin.stepId), {
          id: messageId, label: '生成式编辑',
          // ★ 记住用户当初那句话 —— 「再来一版」靠它重跑（见 onRerun）。
          //   存的是**模型给的那句英文 editPrompt**（`applyDecision` 从决策里
          //   传下来的），不是用户的中文原话：重跑要的是"当初送去生成的那一份"，
          //   中文那句还得再过一遍模型才能变成它，而重跑不该再花一次路由的钱。
          //   （"保留人脸"那半句是服务端 buildEditPrompt 补的，重跑同样会补。）
          prompt: editPrompt,
          base: nextBase, params: paramsAtStep, isOriginal: false, thumb: '',
          // ★ 2026-10-05（滤镜）：这一步的滤镜**用传进来的那个**（`lutAtStep`），
          //   不是闭包里"此刻手上"的那个 —— 理由见函数头（`onRerun` 先跳再重掷）。
          lut: lutAtStep,
        })
        // 被切掉的 + 被挤出去的位图都要释放；原图永远不关。close() 幂等，
        // StrictMode 双调用 updater 也安全。
        for (const s of bitmapsToClose(prev, next, { protectOriginal: true })) {
          s.bitmap.close()
        }
        return next
      })
      // ★ 切对话：**两个 id 之间**的才是旧未来（设计 §4.3）。
      //   ⚠️ 不能只写 `x.id > origin.stepId` 一刀切 —— 用户刚说的那句话、
      //   模型刚回的那几句，id **也大于**步骤 id，一刀切会把它们一起删掉。
      //   ⚠️ 而且**站在最新一步生成时不切**（设计 §4.1 的原话是"从一个**不是最新**
      //   的步骤出发"才切）：那段区间里可能躺着**不推步骤的消息** —— 恢复回来的
      //   一句没收尾的话、参数类的来回（"再亮一点"不产生步骤）。它们不属于任何
      //   "旧未来"，切了就是用户没同意过的一段话凭空消失（旧用例「接着说话不许
      //   撞号」当场抓到过：站在 tip 上生成，把前面那句普通的话一起删了）。
      if (origin.stepId !== tipId) {
        setMessages(m => m.filter(x => x.id <= origin.stepId || x.id >= origin.keepFromMsg))
      }
      setImage(nextBase)
      // ★ 位置挪到新那一步（它是新的"最新"）。
      setCursorId(messageId)
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
    // ⚠️ 依赖里**没有 `lut`**（2026-10-05 复审定下的）：这一步的滤镜是**传参**
    //    进来的（`lutAtStep`），读闭包那个正是这次修掉的 bug。同理也没有 `params`。
    //    ⚠️ 别看这里干净就去删 `deps.lut` —— `applyDecision` 还读它（见那边）。
    // ★ 2026-10-05：`tipId` **要进** —— 切对话那道闸门拿它判"出发的那一步是不是
    //   最新"（见上面那行 `if`）。它变了（又推了一步）而回调还在用旧值时，
    //   站在新 tip 上生成会被当成"从旧步骤出发"—— 用户没同意过的一段话就没了。
  }, [noticeBad, say, tipId])

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
  const applyDecision = useCallback(async (d: RouteDecision, keepFromMsg: number) => {
    // 铁律：增量的叠加与钳制交给确定性代码，LLM 只负责"大概要多少"。
    // 这里显式算出新值（而不是用函数式更新），因为生成那一步的快照要用它。
    const nextParams = (d.route === 'params' || d.route === 'both')
      ? applyDeltas(params, d.paramDeltas)
      : params
    if (nextParams !== params) setParams(nextParams)

    // ★ 2026-10-05 滤镜：和 params 同一级别（本地、不推快照）。
    //   `name === ''` 是"摘掉"（模型对"不要滤镜了"的答案）；有名字就在**本地清单**
    //   里对号 —— 对不上说明模型编了一个（服务端那层本该拦下，这是第二道），
    //   留一行警告、**不动**当前状态：宁可什么都不做，也别套一个用户没导入的东西。
    //
    // ⚠️ 顺手记住"这一步做完之后手上该是哪个"（`nextLut`，和 `nextParams` 对称）：
    //   "套滤镜 + 生成"可以是**同一次决策**（route=both），而生成那一步的快照
    //   要记的是**做完之后**的状态。传旧的（闭包那个）的话，那一步的缩略图
    //   （从带新滤镜的画布上抓的）和「回到这一步」还原出来的主画面就对不上 ——
    //   T8 修过两次的那一类（plan「已被证伪」第 6/7 条）。
    let nextLut = lut
    if (d.lut) {
      if (d.lut.name === '') { setLut(null); nextLut = null }
      else {
        const hit = luts.find((l) => sameLutName(l.name, d.lut!.name))
        if (hit) { nextLut = { lutId: hit.id, amount: d.lut.amount }; setLut(nextLut) }
        else console.warn('模型给了一个不在清单里的滤镜名：', d.lut.name)
      }
    }

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
      // ★ 2026-10-05（Task 4 修正，控制器裁定）：这条路**保留**那句 reply ——
      //   它一直是「好。」+「我不太确定…」两条气泡（先表态、再问），T4 把下面
      //   那句 `say` 统一下移时顺手丢掉了它，这里补回来（T2 的 brief 也是这么写的）。
      say(d.reply || '好了。')
      say('我不太确定你指的是哪个 —— 在图上点一下要改的地方？')
      // 记住他原来那句话：点了之后要连着标记一起再送，不能让他重说一遍。
      // 标记清空 —— 还没点。（pendingRef 为 null 只有"没人说过话就走到了这里"
      // 才会发生，今天走不到；空串和原来的 null 一样是"没有原话"，
      // canConfirmMark 照样不会亮。）
      setPending({ text: pendingRef.current ?? '', marker: null, keepFrom: keepFromMsg })
      return
    }

    const isGen = d.route === 'generate' || d.route === 'both'
    // ★ 2026-10-05（设计 §4.5）：从**旧步骤**生成 = 会把后面切掉 —— 先问一句。
    //   钱一分没花，那句 `reply` 也**还没说**（说了再点「算了」就是"说了不做"）。
    if (isGen && image && cursorId !== null && tipId !== null && cursorId !== tipId) {
      setPendingReplace({
        stepId: cursorId, editPrompt: d.editPrompt,
        reply: d.reply || '好了。', keepFromMsg,
      })
      return
    }

    const mid = say(d.reply || '好了。')

    // 送**当前的 base**（= image.bitmap），不是最初那张原图 —— spec §3.5。
    // ⚠️ `image` 必须进依赖数组：漏了它，这个回调会永远捕获第一次 render 的
    // image（null），生成再也不会被触发——而且是静默的：气泡照出、回复照有，
    // 照片纹丝不动，测试和 typecheck 却全绿。
    // ★ 2026-10-05（滤镜）：这条路（send / 卡片触发的路由决策）**就是"此刻"**——
    //   所以传的是闭包里那个 `lut`，和上面 `params` 同一条口径。
    //   ⚠️ 它读 `lut`，所以 `lut` 必须进依赖数组（同 `image` 那条的理由）。
    if (isGen && image && cursorId !== null) {
      // ★ T11：传 `nextLut`（这一步做完之后那个），和 `nextParams` 对称 ——
      //   理由见上面滤镜那块。⚠️ 别"顺手"改回闭包的 `lut`。
      await runGenerate(d.editPrompt, mid, nextParams, nextLut, image.bitmap,
        { stepId: cursorId, keepFromMsg })
    }
    // ★ T11 又读了 `luts` / `setLut`（上面那块滤镜落地），两个都得进依赖数组 ——
    //   漏掉 `luts` 的话，清单刷新之后这个回调还在用旧的（名字换成错 id）；
    //   `setLut` 是 useState 的 setter（identity 稳定），进来只是守住这条规矩。
    // ★ 2026-10-05：`cursorId` 同上 —— 生成分支读它（切口的切点），漏了它，
    //   跳转之后这个回调还在用上一轮的位置，切口切错地方，而且不报错。
    // ★ 2026-10-05（设计 §4.5）：`tipId` 和 `setPendingReplace` 也进来 ——
    //   前者判"出发的那一步还是不是最新"（要不要先问一句），后者是挂那条确认条；
    //   漏了 `tipId`，站在新 tip 上生成会被当成"从旧步骤出发"，白白多问一次。
  }, [params, say, runGenerate, image, lut, luts, setLut, cursorId, tipId, setPendingReplace])

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
  return { say, runGenerate, stopGeneration, applyDecision, loadCards, nextId }
}
