import { useCallback, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import ChatPanel, { type ChatMessage } from './ui/ChatPanel'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { applyDeltas, ZERO, type Adjustments } from '../shared/adjustments.ts'
import { exportImage } from './export/save'
import { prepareForModel, prepareForRouting } from './image/prepare'
import { ApiError, postEdit, postRoute, postSuggest } from './api/client'
import { bitmapsToClose, jumpTo, pushSnapshot, type Snapshot } from './core/history'
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

export default function App() {
  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  const [showPanel, setShowPanel] = useState(false)
  /** 非 null 时既是"正在忙"的标志，也是要显示给用户的那句话 */
  const [busy, setBusy] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cards, setCards] = useState<SuggestCard[]>([])
  const [history, setHistory] = useState<Snapshot[]>([])

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const originalFileRef = useRef<File | null>(null)
  const idRef = useRef(0)
  /** 每次选图 +1。晚到的卡片结果靠它对号，免得贴到下一张照片上。 */
  const pickIdRef = useRef(0)

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
   * 用户当前的参数值作为**文本上下文**已经由服务端交给 LLM 让它补偿
   * （spec §3.5：确定性比聪明重要）。
   */
  const runGenerate = useCallback(async (
    editPrompt: string, messageId: number, paramsAtStep: Adjustments,
    source: DecodedImage,
  ) => {
    if (!editPrompt) return
    setBusy('正在改…大约 10 秒')
    try {
      // 传 .bitmap —— prepareForModel 要的是能 drawImage 的东西，
      // 不是 DecodedImage 那个包装对象
      const prepared = await prepareForModel(source.bitmap)
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
          base: nextBase, params: paramsAtStep, isOriginal: false,
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
    // （图上点一下的完整形态在计划三；这里先把"拿不准就别动手"做对。）
    //
    // 文案必须中性：模型会在**没有第二个人**的照片上说拿不准（记录里有它的原话
    // "后面好像只有山，没看到另一个人"），歧义也未必关于人（哪片天？哪块牌子？）。
    if (d.needsDisambiguation) {
      say('我不太确定你指的是哪个，再说细一点？')
      return
    }

    // 送**当前的 base**（= image），不是最初那张原图 —— spec §3.5。
    // ⚠️ `image` 必须进依赖数组：漏了它，这个回调会永远捕获第一次 render 的
    // image（null），生成再也不会被触发——而且是静默的：气泡照出、回复照有，
    // 照片纹丝不动，测试和 typecheck 却全绿。
    if ((d.route === 'generate' || d.route === 'both') && image) {
      await runGenerate(d.editPrompt, mid, nextParams, image)
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
      const img = await decodeImageFile(file)

      // 先释放上一张：ImageBitmap 占的是 GPU 内存，不关会一直攒着。
      // 要关的是**整份旧 history**——除了原图，还有每条生成式快照的 base
      // （2048 长边，最多 6 条）。只关原图会漏掉它们，换几次图就能把标签页拖垮。
      // 副作用留在状态更新外面，别塞进 updater（updater 可能被重放）。
      for (const s of bitmapsToClose(history, [])) s.bitmap.close()

      originalFileRef.current = file
      setImage(img)
      setParams(ZERO)
      setMessages([])
      setCards([])

      // 原图自己也算一步，挂在欢迎语那条消息上 —— 这样「回到这一步」
      // 能回到最开始，撤销第一次生成时特别有用。
      const welcomeId = say('准备好啦，说说想怎么改？')
      setHistory([
        { id: welcomeId, label: '原图', base: img, params: ZERO, isOriginal: true },
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

  const onJump = useCallback((id: number) => {
    const target = history.find(s => s.id === id)
    if (!target) return
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
  }, [history])

  // 导出：画布尺寸就是当前 base 的尺寸。调色不缩图（spec §4.4）
  const onSave = useCallback(async () => {
    const canvas = canvasElRef.current
    const file = originalFileRef.current
    if (!canvas || !file) return
    setSaving(true)
    try {
      await exportImage(canvas, file, 'image/jpeg', 0.95)
    } catch (e) {
      console.error(e)
      alert('保存失败，再试一次')
    } finally {
      setSaving(false)
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">RuiXing</span>
        {image && (
          <div className="actions">
            <button onClick={() => setShowPanel(v => !v)}>微调</button>
            <button className="primary" onClick={onSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
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
            <Canvas image={image} params={params} canvasRef={canvasElRef} />
          </div>
          <ChatPanel
            messages={messages}
            cards={cards}
            busy={busy}
            onSend={send}
            onCard={onCard}
            onJump={onJump}
            jumpableIds={history.map(s => s.id)}
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
