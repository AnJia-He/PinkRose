import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Plus, TriangleAlert } from 'lucide-react'
import {
  ALIAS_REQUIRED, BASE_URL_REQUIRED, KEY_REQUIRED, MODEL_ID_REQUIRED, NEED_KEY,
} from '../../shared/copy.ts'
import {
  UNREADABLE_KEY_HINT, activateModel, createModel, deleteModel, listModels, testModel, updateModel,
  type ModelKind, type ProbeTarget, type ProbeResult, type PublicConfig,
} from '../api/models'
import { Field, TextInput } from './kit/Field.tsx'
import { Btn } from './kit/Btn.tsx'

/**
 * 模型设置（§7.4）。**这一页是"限制"那件事的门面**，不是能力展示 ——
 * 顶上那两句话说完就完了：不配就用我们准备的、正在用的那一类花的是他自己的额度；
 * 以及**照片和你说的话会出设备**（§7.3 那句「但隐私那一句照说」，三条见 §7.8）。
 *
 * 三条贯穿全页的规矩，动这一页之前先读一遍：
 *
 * ⚠️ **型号名是羞耻的，别名才是给人看的**（§7.4）。名单里只出现别名，
 *    型号名只在"翻开来"的编辑表单里露那一下。这条不是审美 —— §7.3 说得很直白：
 *    用户看到的该是限制（"这套能干什么"），不是型号（"你用的是谁家哪个版本"）。
 *    这也正是我们**不许**预填自己地址的原因：预填等于把我们用的是哪家写在用户脸上。
 *
 * ⚠️ **页面上没有明文钥匙，也永远拿不到**（§7.7）。服务端只回 `keyHint`（头尾两位），
 *    这一页连"想回显"都做不到 —— 唯一要做的判断是"这个 hint 是不是那个
 *    「读不出来」的占位"，是的话那一行得显眼、得当场给「换一把」。
 *
 * ⚠️ **拿不到就说拿不到**。名单拉不回来时**绝不画成空名单**，因为那对一个
 *    配了三套模型的人是一句假话（他会照着这个画面重配一遍）——
 *    和用户管理页「0 张作品」那个毛病是同一个（见 AccountPage 的注释）。
 */

/**
 * 两栏（§7.4：两个类别互相独立 —— 对话那套挂了，图片那套照用）。
 * 标题走**能力描述**，不走型号（§7.3）：用户挑的是"看照片、听懂话"还是"把照片改掉"。
 */
const KINDS: readonly { kind: ModelKind; title: string; what: string; noun: string }[] = [
  { kind: 'chat', title: '对话与理解', what: '看照片、听懂你的话', noun: '对话模型' },
  { kind: 'image', title: '图片生成', what: '真的把照片改掉', noun: '图片模型' },
]

/**
 * 存进去的"服务商"那一列。
 *
 * ⚠️ 界面**不问用户这一格**，有意的：问了就要在屏幕上写出几家的名字，
 *    而那是 §7.3 明令不写的东西；而它对用户的行为**没有任何影响** ——
 *    服务端造客户端只看地址 + 钥匙 + 型号名（`server/clientFor.ts` 从不按
 *    `provider` 分叉，市面这些接口本来就是同一个 OpenAI 兼容协议）。
 *    问一个不影响任何结果、还要报出几家名字的问题，是纯加负担。
 */
/**
 * 图片那一栏恒定存的协议形状。
 *
 * ⚠️ 界面**不问用户"哪家厂商"**（这原来是硬编码 `openai-compatible` 那段注释的
 *    全部理由，一条没变）：问了就要在屏幕上写出几家的名字，而那是 §7.3 明令
 *    不写的东西；而"厂商"对行为**没有任何影响** —— 服务端造客户端只看地址 +
 *    钥匙 + 型号名，市面这些接口本来就是同一个 OpenAI 兼容协议。
 *
 * ★ 2026-10-05 起多了另一种**协议形状**（`Shape`）：「兼容 Anthropic」
 *    （Claude 官方那种 /v1/messages 形状）。这跟"厂商"是两回事 ——
 *    形状**真的决定发出去的请求长什么样**，也是用户从服务商文档上抄得下来的。
 *    ⚠️ 下拉**只在「对话与理解」那一栏**：图片生成没有 Anthropic 形状的服务
 *    （`server/models.ts` 的 `assertProviderFitsKind` 也拦着）。
 */
const PROVIDER = 'openai-compatible'
type Shape = 'openai-compatible' | 'anthropic-compatible'

/**
 * 这一页那几句「必填 / 得重填钥匙」的话**都在 `shared/copy.ts` 里**，不在这一页。
 *
 * ★ 为什么：服务端为同一个毛病也要说一句，而且它才是"规矩"（请求可以伪造，
 * 这一页只是先一步告诉他，省掉一次注定 400 的往返）。同一个毛病在两个地方
 * 两种说法，用户会以为这是两件事 —— 2026-09-30 之前它们是**各写了一遍**的。
 */

export function ModelSettings() {
  /** 名单。`null` = 还没拿到（见下面 loadError 那条注释，拿不到就不画空名单）。 */
  const [configs, setConfigs] = useState<PublicConfig[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 打开的表单：`config: null` = 新建一套。同时只开一个 —— 一页两栏并排填表更糊涂。 */
  const [form, setForm] = useState<{ kind: ModelKind; config: PublicConfig | null } | null>(null)
  /** 删掉"正在用的那一套"之后那条提示（§7.4）。null = 没这事。 */
  const [warn, setWarn] = useState<{ kind: ModelKind; noun: string } | null>(null)
  /** 删/切失败时服务端说的那句话，原样显示。 */
  const [actionError, setActionError] = useState<string | null>(null)

  /**
   * 每次重拉 +1，只认最后一次的响应。
   *
   * ⚠️ 这不是"多点代码更稳"：删完一套之后马上再切一套，两个请求同时在路上，
   *    先发的那个晚回来就会把新名单盖回旧的那一份 —— 屏幕上表现为
   *    "删了还在""切了没动"，而服务端其实已经做完了。用户接下来会去重复操作。
   */
  const seqRef = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const r = await listModels()
      if (seqRef.current !== seq) return
      setConfigs(r.configs)
      setLoadError(null)
    } catch (e) {
      if (seqRef.current !== seq) return
      // ★ 失败时**不清成空数组**：`configs` 留在 null，两栏就整套不画
      //   （见上面那段注释）。里头的消息原样显示，服务端说了什么就是什么。
      setConfigs(null)
      setLoadError(e instanceof Error ? e.message : '打不开模型设置')
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const onDelete = useCallback(async (c: PublicConfig, noun: string) => {
    setActionError(null)
    try {
      const r = await deleteModel(c.id)
      // ★ 删掉的正好是编辑表单里开着的那一套：把表单收起来。
      //   不收的话表单还停在原地，里面那颗「保存」打过去是 404（那一套已经没了），
      //   用户会以为是网络抽风。**只在删成功之后收** —— 删失败时留着，
      //   他刚敲进去的字不该被我们抹掉。
      setForm((f) => (f?.config?.id === c.id ? null : f))
      // ★ 弹不弹提示看的是服务端回的 **wasActive**，不是我们这边猜的 ——
      //   `c.active` 是上一次拉名单时的事实，中间用户可能在别处切过。
      //   删掉不是在用的那套时**一句都不说**（§7.4："就删掉，什么都不变"），
      //   那时候说"已经切回默认"是假话，还会让人以为闯了祸。
      setWarn(r.wasActive ? { kind: c.kind, noun } : null)
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '没删掉，再试一次')
    }
  }, [reload])

  const onActivate = useCallback(async (kind: ModelKind, id: number | null) => {
    setActionError(null)
    // ★ 一动手换模型，那条"你删掉的这套正在用"的警告立刻撤掉。
    //   它是"删除那一刻"的快照；用户删完随手点了「用这个」或「用回默认」，
    //   警告还挂着的话，一屏上就同时有两句互相打架的现状描述（相隔两次点击）。
    //   「用这个」和「用回默认」都走这个函数，所以清在这里 = 两条路都清。
    setWarn(null)
    try {
      await activateModel(kind, id)
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '没换过去，再试一次')
    }
  }, [reload])

  return (
    <section className="models">
      <h1 className="models-title">模型设置</h1>
      {/* 顶上这句话是全页的**前提**：不说清"不配会怎样、在用谁的花谁的钱"，
          用户连该不该往下看都判断不了。
          ⚠️ 措辞是"**正在用的那一类**"，改过两回：
          · 计划里原来是"配了之后，改图花的是你自己的额度" —— 对**只配了对话**
            的人是句假话：他那一栏配上了，可"图片生成"那一栏还在用我们准备的
            （§7.4：两类互相独立），于是 2026-10-01 通读时改成"配了的那一类"。
          · 而"配了的那一类"在**存了但没启用**时照样不真 —— `clientFor` 会安静地
            回默认，同一栏两行之下的「当前：」正写着"用默认（本服务提供）"，
            页面自己跟自己打架。最终审查（2026-10-01）指出，改成如今这句：
            **每种配置状态下都真**（《文案规范》第三条）。 */}
      <p className="models-lede">不配就用我们准备的；正在用的那一类，花的是你自己的额度。</p>
      {/* 隐私那一句（§7.3 明写「但隐私那一句照说」，三条见 §7.8）：
          发给谁 / 经不经过我们（**经过** —— 所以不许说"我们看不见"）/ 我们拿它干嘛。
          ⚠️ 两个措辞上的讲究，动它之前先看明白：
          · **不点名具体哪家**（§7.3）：写"第三方模型服务商"，不写我们用的是谁；
          · **不能带"你配的模型……"这种前提** —— 什么都没配的人（走的是我们准备的
            那一家）也要读到同一句真话，所以主语只能是"照片和你说的话"。 */}
      <p className="models-privacy">照片和你说的话会经过我们的服务器转给第三方模型服务商；我们只转发，不拿去训练。</p>

      {/* ★ 拉不到名单：说出来 + 给下一步。**不许**画成空名单（见文件头那段）。 */}
      {loadError && (
        <>
          <p className="models-error">{loadError}</p>
          <p className="models-hint">刷新一下页面，再试一次。</p>
        </>
      )}
      {!configs && !loadError && <p className="models-hint">正在打开…</p>}
      {actionError && <p className="models-error">{actionError}</p>}

      {configs && KINDS.map(({ kind, title, what, noun }) => {
        const mine = configs.filter((c) => c.kind === kind)
        const active = mine.find((c) => c.active) ?? null
        return (
          <section className="models-group" key={kind}>
            <h2 className="models-group-title">
              {title}<span className="models-group-what">{what}</span>
            </h2>

            {mine.length > 0 && (
              <ul className="models-list">
                {mine.map((c) => (
                  <li className="models-row" key={c.id}>
                    {/* ✓ 是"在用"的唯一标记。名字排在它后面 ——
                        用户先看"哪个在用"，再看"它叫什么"。
                        ★ 2026-10-01：那个 ✓ 字符换成图标（它是 svg，不进 textContent）。
                        ⚠️ `ModelSettings.test.tsx` 里原来断言的是 `textContent` 含 '✓'，
                        跟着改成"这一行里有那个记号元素/图标"。 */}
                    <span className="models-mark">{c.active ? <Check size={15} strokeWidth={1.5} aria-hidden="true" /> : null}</span>
                    <span className="models-alias">{c.alias}</span>
                    {/* 在用的那一行不给「用这个」：已经有 ✓ 了，再给一颗
                        "再点一次"的按钮，按下去什么都不会变，最让人迷惑。 */}
                    {!c.active && (
                      <button type="button" onClick={() => void onActivate(kind, c.id)}>用这个</button>
                    )}
                    <button type="button" onClick={() => setForm({ kind, config: c })}>编辑</button>
                    <button type="button" onClick={() => void onDelete(c, noun)}>删除</button>
                  </li>
                ))}
              </ul>
            )}

            {/* §7.4：删掉正在用的那套 = 鲜明提示 + 一个换一套的入口。
                只提示不给入口等于把人扔在半路（他知道了，可接下来往哪走？）。 */}
            {warn?.kind === kind && (
              <div className="models-warn">
                <p>
                  <span className="models-warn-mark" aria-hidden="true"><TriangleAlert size={15} strokeWidth={1.5} /></span>{' '}
                  你删掉的这套，正是你现在在用的{noun}。已经切回默认模型了。
                </p>
                <div className="models-warn-actions">
                  <button type="button" onClick={() => { setWarn(null); setForm({ kind, config: null }) }}>
                    换成其他的
                  </button>
                  <button type="button" onClick={() => setWarn(null)}>知道了</button>
                </div>
              </div>
            )}

            {form?.kind === kind ? (
              // ⚠️ `key` 不是装饰：换一个编辑对象时（或者从"编辑 A"跳到"新建"）
              //    必须让 React **重挂**这个表单 —— 否则 useState 的初值还是上一次的，
              //    用户会看到别人家的地址和型号名，一存就存错了。
              <ModelForm
                key={`${kind}:${form.config?.id ?? 'new'}`}
                kind={kind}
                config={form.config}
                onSaved={async () => { setForm(null); await reload() }}
                onCancel={() => setForm(null)}
              />
            ) : (
              <button type="button" className="models-add" onClick={() => setForm({ kind, config: null })}>
                <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
                添加一套
              </button>
            )}

            <p className="models-now">
              当前：{active ? active.alias : '用默认（本服务提供）'}
              {active && (
                // §9：得有一条回默认的路。没有它，想回默认只能把这套删掉 ——
                // 拿删除当开关用，配置也跟着丢了。
                <button type="button" onClick={() => void onActivate(kind, null)}>用回默认</button>
              )}
            </p>
          </section>
        )
      })}
    </section>
  )
}

/** 「测一下」这一刻的画面：还没试 / 正在试 / 试完了（成功或失败都算试完了）。 */
type Probe =
  | { state: 'idle' }
  | { state: 'busy' }
  /**
   * ⚠️ `done` 里**连"测的是哪一份表单值"一起记下来**（2026-10-01 最终审查 ①）。
   * 原来是只记结果 —— 测通 A 家之后把地址改成 B 家，屏幕上照样写着
   * 「通了，地址和钥匙都对。」，而 B 家从没被验过；下拉里那份型号名单也还是
   * A 家的。这正是这一版反复抓的那类假话：**拿"过去某一刻为真"的一句话，
   * 对着现在这一刻说**（而且它正落在本功能最核心的断言上，§7.3）。
   * 渲染前拿这三个值和当前表单对一遍，对不上就当没测过。
   */
  | { state: 'done'; result: ProbeResult; url: string; key: string; name: string }

/**
 * 一套模型的新建 / 编辑表单。
 *
 * ★ 它最重要的一件活儿是**让"改了地址没重填钥匙"这件事根本撞不上**（见 `save`
 *   里那几道 guard）：服务端那条规矩（改了 baseUrl 就必须同请求带 apiKey，
 *   否则 400）是**故意的安全性质**，不是可以绕过的刁难 —— 而用户没有任何理由
 *   知道它。所以由这一层把他挡在 400 前面，并且用服务端的原话解释为什么。
 */
function ModelForm({
  kind, config, onSaved, onCancel,
}: {
  kind: ModelKind
  config: PublicConfig | null
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const [alias, setAlias] = useState(config?.alias ?? '')
  /**
   * ★ 新建时**从空开始**（§7.3：不暴露我们自己用的是哪家）。一格都不许替他填好，
   *   连 placeholder 都不许写我们的地址 —— 用户多半会原样存下来，从此走我们的额度，
   *   而他从头到尾不知道这件事。
   *
   *   编辑一套**已经存好的**时显示他自己填的那个：那是他自己的东西；
   *   而且不预填他就没法只改个别名（服务端按"请求里有没有 baseUrl"判要不要重填钥匙）。
   *
   * ⚠️ 这张表单永远只用来编辑**同一个** config（换对象时上层用 `key` 重挂），
   *    所以 useState 的初值就是这一份，不会串。
   */
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  /**
   * 协议形状（★ 2026-10-05）。编辑一套**老配置**时：`anthropic-compatible`
   * 照实显示；其余（含历史值 `custom`）都映射到「兼容 OpenAI」—— 那是它们
   * 一直以来的行为，而且**保存一次就把它规范成明确值**（`custom` 是历史遗留）。
   */
  const [shape, setShape] = useState<Shape>(
    config?.provider === 'anthropic-compatible' ? 'anthropic-compatible' : 'openai-compatible')
  const [modelId, setModelId] = useState(config?.modelId ?? '')
  /** **明文钥匙永远不预填**（§7.7）—— 空 = "不动库里那一把"。 */
  const [apiKey, setApiKey] = useState('')
  /** 钥匙那一格摊开了没有。新建时本来就该填，直接摊开；编辑时先收起（只给 keyHint）。 */
  const [keyOpen, setKeyOpen] = useState(config === null)
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const url = baseUrl.trim()
  const key = apiKey.trim()
  const name = modelId.trim()
  /** 实际要提交/使用的形状 —— 图片那一栏恒定 `PROVIDER`（没有第二种可选）。 */
  const provider: Shape = kind === 'chat' ? shape : PROVIDER
  /**
   * 地址**动了没有**，基准是库里存着的那一份（服务端归一化之后就是它）。
   *
   * ⚠️ 这个判断是下面全部防线的地基：服务端凭"请求里**有没有 baseUrl**"决定
   *    要不要强制重填钥匙 —— 带了就是要求用户重填，哪怕值和库里一模一样。
   */
  const urlChanged = url !== (config?.baseUrl ?? '')
  const badKeyHint = config?.keyHint === UNREADABLE_KEY_HINT

  /**
   * 这次结果还是不是**当下这一份**表单的（地址 / 钥匙 / 模型名，任一和测的那一刻
   * 不同就不算 —— 见 `Probe` 的注释）。
   *
   * ★ 用"记下测的是哪一份 + 渲染时比对"，而不是"在 onChange 里把它清掉"：
   *   后者挡不住**在探测途中**改字的那种情况（请求还在路上，回来时照样落一个
   *   对不上的结果），比对是**唯一一个没有时间窗的写法**。
   */
  const probeFresh =
    probe.state === 'done' && probe.url === url && probe.key === key && probe.name === name
  /** 测通了之后，上游报回来的型号名单（填下拉用；也可能一个都没有）。 */
  const options = probeFresh && probe.result.ok ? probe.result.models : []

  async function runProbe() {
    if (probe.state === 'busy') return
    setError(null)
    // 测的**永远是用户眼睛正盯着的那一份**（`api/models.ts` 里 ProbeTarget 那段）。
    let target: ProbeTarget
    if (key !== '') {
      // ⚠️ 带上**表单里选的形状** —— 不带的后果是探活还发 OpenAI 那套请求头，
      //    Anthropic 形状的服务回 401/400，用户被指去查一把根本没问题的钥匙。
      target = { baseUrl: url, apiKey: key, provider }
    } else if (config && !urlChanged) {
      // 编辑一套存好的、地址又没动过：表单里没有明文钥匙（永不回显），
      // 而库里那份和表单里这份是同一个地址 —— 让服务端用存着的那把钥匙探。
      target = { kind, id: config.id }
    } else {
      // 地址改了却没有钥匙（或者新建时钥匙还空着）—— 这一下**没法测**：
      // 拿库里那把钥匙去探新地址是拿真钥匙去敲别人家的门，绝不能干。
      setError(url === '' ? BASE_URL_REQUIRED : NEED_KEY)
      return
    }

    setProbe({ state: 'busy' })
    try {
      // 探不通也是 200（那是"这次探活的结果"）—— 会走到 catch 的只有
      // "这个请求本身没成"（没登录 / 服务端挂了）。
      const result = await testModel(target)
      // 连"测的这份值"一起存（`url` / `key` / `name` 是**点按钮那一刻**闭包里的
      // 值）：用户在等结果时改过任何一格的话，渲染那一步自然对不上 ——
      // 结果不会落在一个已经变了的表单上。
      setProbe({ state: 'done', result, url, key, name })
    } catch (e) {
      setProbe({ state: 'idle' })
      setError(e instanceof Error ? e.message : '没能试成，再试一次')
    }
  }

  async function save() {
    if (saving) return
    setError(null)
    const a = alias.trim()
    const m = modelId.trim()

    // 本地先挡一遍。拦下来的每一条服务端也会拦，但用户看到的应该是**人话**，
    // 而不是请求绕一圈回来的一句"400"。
    // 最要紧的是 NEED_KEY 那条：它挡住的是一次**注定 400** 的请求，
    // 而且那句 400 后面藏着一条安全性质（`src/api/models.ts` 的 updateModel 那段）。
    if (a === '') return setError(ALIAS_REQUIRED)
    if (url === '') return setError(BASE_URL_REQUIRED)
    if (config === null && key === '') return setError(KEY_REQUIRED)
    if (m === '') return setError(MODEL_ID_REQUIRED)
    if (urlChanged && key === '') return setError(NEED_KEY)

    setSaving(true)
    try {
      if (config === null) {
        await createModel({ kind, provider, alias: a, baseUrl: url, apiKey: key, modelId: m })
      } else {
        await updateModel(config.id, {
          provider,
          alias: a,
          modelId: m,
          // ⚠️ 地址没动就**一个字都不提 baseUrl**（提了 = 逼他重填一把没坏的钥匙）；
          //    动了就必须连着钥匙一起发 —— 这两句是一件事的两面。
          ...(urlChanged ? { baseUrl: url, apiKey: key } : key !== '' ? { apiKey: key } : {}),
        })
      }
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '没存进去，再试一次')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="models-form"
      onSubmit={(e) => { e.preventDefault(); void save() }}
    >
      <h3 className="models-form-title">{config ? `编辑「${config.alias}」` : '添加一套'}</h3>

      {/* ★ 2026-10-05：用户发来别家的配置表单截图说「你看人家的引导」——
          学来这一句"点题"。它回答的是打开表单后的第一个问题：**我在填什么**。
          两截都不能少：「兼容 OpenAI 协议」告诉用户"接口地址"该填哪种服务的；
          「哪一家都行」是关键 —— 少了它，用户以为只能填 OpenAI 官方
          （那口子在国内根本用不了），这个功能就白做了。
          ⚠️ 这**不违反** §7.3（那条禁的是写出**我们自己**用的服务商）——
          这句说的是"你可以接什么"，正是不写型号名之后最该给的那块信息。
          编辑态不显示：他早懂了，不重复唠叨。 */}
      {config === null && (
        <p className="models-form-lede">填一个兼容 OpenAI 协议的服务 —— 哪一家都行。</p>
      )}

      {/* 协议形状（★ 2026-10-05，照人家那颗「提供商」下拉学的）。**只在对话栏** ——
          图片生成没有 Anthropic 形状的服务（服务端第二道拦着，见 `models.ts`）。
          文案上"兼容"两个字不能省：用户手里的服务多半两家都不是，是"兼容某一家"的。 */}
      {kind === 'chat' && (
        <Field className="models-field" label="提供商" hintClassName="models-hint"
               hint="「兼容 OpenAI」是绝大多数服务；「兼容 Anthropic」是 Claude 官方那种接口。">
          <select id="model-provider" className="models-select" value={shape}
                  onChange={(e) => setShape(e.target.value as Shape)}>
            <option value="openai-compatible">兼容 OpenAI</option>
            <option value="anthropic-compatible">兼容 Anthropic</option>
          </select>
        </Field>
      )}

      <Field className="models-field" label="别名" hintClassName="models-hint"
             hint="别名是给你自己认的，名单里显示的就是它。">
        {/* 别名是**给用户自己认的**（§7.4）：名单里到处显示的都是它，型号名藏在下面。
            这条注解只说"它是干嘛的"，不提长度 —— 上限在服务端，超了那边会说人话。

            ⚠️ 2026-10-01 起：标签 / 输入框 / 注解这三样由 `<Field>` 摆，
            它顺带把注解用 `aria-describedby` 和输入框连上（换之前全仓一条都没有）。
            `id="model-alias"` **是测试的锚点**（`ModelSettings.test.tsx:161` 那个
            `field(id)` 按 `#model-*` 找），一个字都不许改。 */}
        <TextInput id="model-alias" value={alias} autoComplete="off"
                   onChange={(e) => setAlias(e.target.value)} />
      </Field>

      <Field className="models-field" label="接口地址" hintClassName="models-hint"
             hint="填域名也行，我们会补上 /v1">
        {/* 那句注解说的是**服务端**会做的归一化（`normalizeBaseUrl`）。
            前端一个字都不自作聪明地补 —— 两处各补各的，规则迟早走岔。

            ★ 2026-10-05：placeholder 给了个人家那种**中性示例**。它不违反
            "不许预填我们自己的地址"那一条（那条防的是把**我们用的哪家**写在
            用户脸上）：`example.com` 是 RFC 2606 的保留域名，谁都注册不了，
            它**永远不可能是**我们自己或任何真实服务商的地址 —— 它只教
            "这一格填什么样"。判据在测试里跟着改成了"只许是这个值"。 */}
        <TextInput id="model-url" value={baseUrl} autoComplete="off" inputMode="url" spellCheck={false}
                   placeholder={provider === 'anthropic-compatible'
                     ? 'https://api.example.com'
                     : 'https://api.example.com/v1'}
                   onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>

      <Field className="models-field" label="模型名" hintClassName="models-hint"
             hint="能从「测一下」带回来的名单里选，也能自己打。">
        {/* 下拉里的名单来自"测一下"（上游那把钥匙能看见的型号）。**同时允许手打**：
            商汤那份名单就不全，我们自己在用的那个不在里面。
            ★ 2026-10-05 placeholder：照人家那句「例如 deepseek」学的 ——
            示例只教"填一截短标识符"这个**形态**；deepseek 是**用户侧**常见的
            选择，和我们自己用什么（§7.3）没有任何关系。 */}
        <TextInput id="model-name" value={modelId} autoComplete="off" spellCheck={false}
                   list="model-names"
                   placeholder={provider === 'anthropic-compatible' ? '例如 claude-sonnet-4-5' : '例如 deepseek'}
                   onChange={(e) => setModelId(e.target.value)} />
        <datalist id="model-names">
          {options.map((n) => <option key={n} value={n} />)}
        </datalist>
      </Field>

      {/* 钥匙那一格（§7.7）。两个分支**各是各的 `<div className="models-field">`**
          （不是"一个壳子里换内容"）：收起态根本没有可操作的控件，
          包在 `<Field>` 里就成了"一个指着不存在的控件的标签"。 */}
      {config && !keyOpen ? (
        <div className="models-field">
          {/* 存着的时候**只给头尾两位**，明文连服务端都不往回送。
              收起状态这儿没有可操作的控件，所以是 `<span>` 不是 `<label>` ——
              标签得指向一个控件，指不到就别假装是标签（读屏软件会念一个不存在的字段）。 */}
          <span>钥匙</span>
          <div className="models-keyrow">
            <b className={badKeyHint ? 'models-keybad' : undefined}>{config.keyHint}</b>
            <button type="button" onClick={() => setKeyOpen(true)}>换一把</button>
          </div>
          {badKeyHint && (
            // 这一句和上面那个红字是**同一件事的两种说法**：红字负责"这里出事了"，
            // 这句负责"那怎么办"（《文案规范》：哪不对 + 怎么办，缺一不可）。
            <p className="models-hint">这一把读不出来了，重填一次才能用。</p>
          )}
        </div>
      ) : (
        /* ★ 2026-10-05：编辑态的注解前面加了「不换就留空」—— 照人家那句
           「内置服务可留空」学的那层安心感：我们的对应物不是"可以不填钥匙"，
           而是"**编辑时不动它就不用填**"（空 = 库里那一把原样留着）。 */
        <Field className="models-field" label="钥匙" hintClassName="models-hint"
               hint={config
                 ? '不换就留空。它只存在我们的服务器上，页面上只会显示头尾两位。'
                 : '只存在我们的服务器上，页面上只会显示头尾两位。'}>
          <TextInput id="model-key" type="password" value={apiKey} autoComplete="off"
                     placeholder={config ? '粘贴新的一把，换掉现在这个' : ''}
                     onChange={(e) => setApiKey(e.target.value)} />
        </Field>
      )}

      <div className="models-probe">
        <button type="button" onClick={() => void runProbe()} disabled={probe.state === 'busy'}>
          {probe.state === 'busy' ? '正在试…' : '测一下'}
        </button>
        {/* ★ 这一行说明是这个按钮**能存在的前提**（§7.3 不许写做不到的事）：
            它证明的只是"地址通、钥匙对"，**不是**"那个模型能用"。
            少了它，这个按钮就在替我们说一句我们做不到的话 —— 而且用户会
            理直气壮地拿它当"配好了"的凭证。 */}
        <span className="models-hint">只验地址和钥匙通不通，不代表那个模型一定能用。</span>
      </div>
      {probeFresh && (probe.result.ok
        ? <p className="models-probe-ok">通了，地址和钥匙都对。</p>
        // 上游那句话原样显示（服务端特意把上游原文挡在外面，翻译成中文再给）。
        // 我们不替它再总结一遍 —— 排查的线索全在那句话里。
        : <p className="models-probe-bad">没通。{probe.result.message}</p>)}

      {error && <p className="models-error">{error}</p>}

      <div className="models-form-actions">
        <Btn type="submit" className="primary" disabled={saving}>
          {saving ? '正在存…' : '保存'}
        </Btn>
        <button type="button" onClick={onCancel} disabled={saving}>取消</button>
      </div>
    </form>
  )
}
