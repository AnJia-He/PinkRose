import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  changePassword, changeUsername, deleteAccount, logout, usage as fetchUsage,
  type AccountUser,
} from '../api/account.ts'
import { errorText } from '../api/client'
import {
  clearMemoryProfile, getMemoryProfile, setMemoryEnabled,
} from '../api/memory.ts'
import { listModels, type PublicConfig } from '../api/models.ts'
import type { MemoryProfile } from '../../shared/memory.ts'
import { Btn } from './kit/Btn.tsx'
import { Field, TextInput } from './kit/Field.tsx'
import type { View } from './view.ts'
import type { Appearance } from '../app/appearance.ts'

/**
 * 用户管理（§3.6）。**先只做骨架**，它是 §12 的第三段。
 *
 * 现在有：用户名 / 使用情况 / 模型 / 默认风格 / 改密码 / 注销账号 / 退出登录。
 * 设置页现有：账号 / 模型 / 默认风格 / 界面外观 / 用量 / 导出默认值（导出面板里）。
 * 默认导出尺寸 / 格式已在导出面板提供「设为默认」——
 * 正合 §12 自己那句「每段做完都能单独用、单独验收」。
 *
 * ⚠️ 页面上**不许出现我们自己用的模型名或接口地址**（§7.3）。
 * 用户看到的只有「默认」和别名 —— 型号名对他没意义，限制才有意义。
 * 这条在「模型」那一行上也是硬约束：那格里写的是**别名**（或者「默认」），
 * 绝不是型号名。
 */

/**
 * 使用情况有三个状态，**一个都不许拿 0 去顶**：
 *   · `loading` —— 还在路上；
 *   · `ready` —— 拿到了，画真数；
 *   · `unavailable` —— 没拿到（网络/服务端出问题）。
 *
 * ⚠️ 这不是"多点代码更稳"，是**一条界面明文**：《文案规范》§3
 * 「不许写产品做不到的事」，写之前先问"这句话在什么情况下是假的？" ——
 * 「0 张作品」对着一个存过 128 张的人就是**假话**，而这页一进去就能看见。
 * 所以宁可少说一句（这一格整个不出现），也不说一句假的。
 *
 * ★ 2026-10-04：数据源从"前端把整份作品清单拉下来自己加"换成了
 *   `GET /api/me` 的 `usage` —— 那边**把会话占的空间也算进去了**
 *   （会话里的原图和每一步的底也是用户的文件），前端那份只看得见作品。
 */
type Usage =
  | { state: 'loading' }
  | { state: 'ready'; count: number; bytes: number; limit: number }
  | { state: 'unavailable' }

type MemoryState =
  | { state: 'loading' }
  | { state: 'ready'; value: MemoryProfile }
  | { state: 'unavailable' }

type DesktopStorageState =
  | { state: 'loading' }
  | { state: 'ready'; path: string; version: string }
  | { state: 'unavailable' }

export function AccountPage({
  user, onGo, onSignedOut, onUserChanged,
  defaultStyleId, styleOptions, styleOptionsKnown = true, onDefaultStyleChange,
  appearance, onAppearanceChange,
}: {
  user: AccountUser
  onGo: (v: View) => void
  onSignedOut: () => void
  /**
   * ★ 2026-10-09（用户原话：「像有些功能对应的增删改查的操作的补充就不要再让我
   * 一再强调了，比如用户名的修改功能」）：**改完名字把新的那份 user 交回去**。
   *
   * 为什么不在这儿自己存一份：`user` 是 **App 的 state**（这一页是"看一眼就走"的
   * 一屏，名字在别处也可能用得上）。这一页自己留一份显示用的副本，就等于同一个
   * 事实有两个答案 —— 而它们迟早会对不上（改完名切走再回来，App 手里还是旧的）。
   */
  onUserChanged: (u: AccountUser) => void
  /** 当前默认风格（预设 id）；null = 新照片从原图起手。 */
  defaultStyleId: string | null
  /** 内置 + 我的预设；`mine` 只用来分组显示。 */
  styleOptions: readonly { id: string; label: string; mine?: boolean }[]
  /** 「我的预设」清单到手了没有；没到手时不能把账号里的数字 id 说成"已不存在"。 */
  styleOptionsKnown?: boolean
  /**
   * 改默认风格。**返回是否同步到账号** —— 本机那份调用方已经先写好了，
   * 网络失败时这一页只说"已保存到这台设备"，不把用户挡在设置里。
   */
  onDefaultStyleChange: (id: string | null) => Promise<{ synced: boolean }>
  /** 修图界面外观：深色 / 浅色。 */
  appearance: Appearance
  /** 改外观；返回是否同步到账号，本机值已经由调用方先写好。 */
  onAppearanceChange: (value: Appearance) => Promise<{ synced: boolean }>
}) {
  const [leaving, setLeaving] = useState(false)
  const [usage, setUsage] = useState<Usage>({ state: 'loading' })
  /**
   * 模型清单（§3.6 那一行右边要写「别名」还是「默认」得看它）。
   * `null` = 还没拿到 / 拿不到 —— 两种情况**都整格不出现**，见下面对应的注释。
   */
  const [models, setModels] = useState<PublicConfig[] | null>(null)
  const [memory, setMemory] = useState<MemoryState>({ state: 'loading' })
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryMsg, setMemoryMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [memoryClearAsk, setMemoryClearAsk] = useState(false)

  // 改密码那一段（§6.5）、改用户名那一段（★ 2026-10-09）、注销那一段（§5）
  // 各自的开合与状态
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [nameOpen, setNameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [nameMsg, setNameMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [delOpen, setDelOpen] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [delMsg, setDelMsg] = useState<string | null>(null)
  const [styleBusy, setStyleBusy] = useState(false)
  const [styleMsg, setStyleMsg] = useState<string | null>(null)
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [appearanceMsg, setAppearanceMsg] = useState<string | null>(null)
  const [desktopStorage, setDesktopStorage] = useState<DesktopStorageState>({ state: 'loading' })
  const [desktopMsg, setDesktopMsg] = useState<string | null>(null)

  useEffect(() => {
    // ★ 2026-10-04：改走 `GET /api/me` 的 usage（作品张数 / 占的空间 / 上限）。
    //
    // ⚠️ `alive`：这页是"看一眼就走"的，请求回来之前人可能已经登出/切页了 ——
    //    晚到的响应不该再写进一棵已经不存在的树上（写进去就是一次 React 警告，
    //    而且是一个"看不见的页面在背后改状态"的形状）。
    let alive = true
    fetchUsage().then(
      (u) => {
        if (!alive) return
        setUsage(u ? { state: 'ready', ...u } : { state: 'unavailable' })
      },
    )
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const bridge = window.pinkroseDesktop
    if (!bridge) return
    let alive = true
    bridge.getStorageInfo().then(
      ({ dataDir, version }) => {
        if (alive) setDesktopStorage({ state: 'ready', path: dataDir, version })
      },
      () => {
        if (alive) setDesktopStorage({ state: 'unavailable' })
      },
    )
    return () => { alive = false }
  }, [])

  const loadMemory = () => {
    setMemory({ state: 'loading' })
    getMemoryProfile().then(
      (value) => setMemory({ state: 'ready', value }),
      () => setMemory({ state: 'unavailable' }),
    )
  }

  useEffect(() => {
    let alive = true
    getMemoryProfile().then(
      (value) => { if (alive) setMemory({ state: 'ready', value }) },
      () => { if (alive) setMemory({ state: 'unavailable' }) },
    )
    return () => { alive = false }
  }, [])

  useEffect(() => {
    // 「模型」那一行右边写什么得知道他在用哪一套 —— 别名从 `/api/models` 来。
    // 这一条和上面那条一样是"看一眼就走"的，所以一样要 `alive`。
    //
    // ⚠️ 拿不到就**什么都不说**（`models` 留在 null，那一格整个不出现）：
    //    退回「默认」等于替用户声明"你没接自己的模型"，而他可能接了 ——
    //    又是一句假话（和「0 张作品」同一个毛病）。
    //    这一行本身照常点得进去，所以少一格不挡他任何事。
    let alive = true
    listModels().then(
      (r) => { if (alive) setModels(r.configs) },
      () => { /* 拿不到就什么都不说 —— 见上 */ },
    )
    return () => { alive = false }
  }, [])

  const submitPassword = () => {
    if (pwBusy) return
    setPwBusy(true)
    setPwMsg(null)
    changePassword(oldPw, newPw).then(
      () => {
        setPwMsg({ tone: 'ok', text: '改好了。其他设备上要用新密码重新登录。' })
        setOldPw('')
        setNewPw('')
      },
      (e) => setPwMsg({ tone: 'err', text: errorText(e, '没改成，过一会儿再试。') }),
    ).finally(() => setPwBusy(false))
  }

  /**
   * ★ 2026-10-09：改名。和上面那条改密码**只差两处**，其余照抄：
   *   · 成功之后要把**新的那份 user 交回 App**（那一行上写着的是它）；
   *   · 那句成功的话说的是"**下次用新名字登录**"—— 改密码那句说的是"其他设备要
   *     重新登录"，**在这一趟是假话**：票里没有用户名，别的设备一个都不会掉
   *     （见 `api/account.ts` 的 `changeUsername`）。
   */
  const submitUsername = () => {
    if (nameBusy) return
    setNameBusy(true)
    setNameMsg(null)
    changeUsername(newName).then(
      (u) => {
        setNameMsg({ tone: 'ok', text: '改好了，下次用新名字登录。' })
        setNewName('')
        onUserChanged(u)
      },
      (e) => setNameMsg({ tone: 'err', text: errorText(e, '没改成，过一会儿再试。') }),
    ).finally(() => setNameBusy(false))
  }

  /**
   * 改默认风格。下拉一改就保存 —— 这一格没有「保存」按钮：
   * 它本来就只有一个选择动作，再让用户按第二下只会多一次"到底存没存"的疑问。
   */
  const chooseDefaultStyle = (raw: string) => {
    if (styleBusy) return
    const id = raw || null
    const label = id ? styleOptions.find(o => o.id === id)?.label : null
    setStyleBusy(true)
    setStyleMsg(null)
    onDefaultStyleChange(id).then(
      (r) => {
        if (!id) {
          setStyleMsg(r.synced
            ? '以后新打开的照片从原图起手，已同步到账号。'
            : '以后新打开的照片从原图起手；账号同步没成功，下次联网再试。')
          return
        }
        setStyleMsg(r.synced
          ? `下一张新照片会用「${label ?? '这套预设'}」起手，已同步到账号。`
          : `下一张新照片会用「${label ?? '这套预设'}」起手；已保存到这台设备，账号同步没成功。`)
      },
      (e) => setStyleMsg(errorText(e, '没保存成功，再试一次。')),
    ).finally(() => setStyleBusy(false))
  }

  const chooseAppearance = (next: Appearance) => {
    if (appearanceBusy || next === appearance) return
    setAppearanceBusy(true)
    setAppearanceMsg(null)
    onAppearanceChange(next).then(
      (r) => setAppearanceMsg(r.synced
        ? `已切到${next === 'light' ? '浅色' : '深色'}界面，并同步到账号。`
        : `已切到${next === 'light' ? '浅色' : '深色'}界面；账号同步没成功，下次联网再试。`),
      (e) => setAppearanceMsg(errorText(e, '没切成功，再试一次。')),
    ).finally(() => setAppearanceBusy(false))
  }

  const chooseMemoryEnabled = () => {
    if (memoryBusy || memory.state !== 'ready') return
    const next = !memory.value.enabled
    setMemoryBusy(true)
    setMemoryMsg(null)
    setMemoryClearAsk(false)
    setMemoryEnabled(next).then(
      (value) => {
        setMemory({ state: 'ready', value })
        setMemoryMsg({
          tone: 'ok',
          text: next
            ? '长期偏好已开启，以后会按你明确说过的稳定习惯来配合。'
            : '长期偏好已关闭，不再读取或更新。',
        })
      },
      (e) => setMemoryMsg({ tone: 'err', text: errorText(e, '没改成，再试一次。') }),
    ).finally(() => setMemoryBusy(false))
  }

  const confirmClearMemory = () => {
    if (memoryBusy) return
    setMemoryBusy(true)
    setMemoryMsg(null)
    clearMemoryProfile().then(
      (value) => {
        setMemory({ state: 'ready', value })
        setMemoryClearAsk(false)
        setMemoryMsg({ tone: 'ok', text: '长期偏好已清除。' })
      },
      (e) => setMemoryMsg({ tone: 'err', text: errorText(e, '没清掉，再试一次。') }),
    ).finally(() => setMemoryBusy(false))
  }

  const confirmDelete = () => {
    if (delBusy) return
    setDelBusy(true)
    setDelMsg(null)
    // 成功之后**整页都属于一个不存在的账号了** —— 直接告诉 App 走人
    //（和退出登录同一条出口：App 收到就把登录页换上）。
    deleteAccount().then(
      onSignedOut,
      (e) => { setDelBusy(false); setDelMsg(errorText(e, '没注销成，过一会儿再试。')) },
    )
  }

  /** §6.6 的 80% 提醒：那一格数字变色 + 下面那句带出路的提醒，都由它决定。 */
  const usageWarn = usage.state === 'ready' && usage.bytes / usage.limit >= 0.8
  /** 账号里记的那套预设可能已经被删了 —— 下拉要如实显示，不许静默显示成"不预设"。 */
  const styleUnknown = !!defaultStyleId && !styleOptions.some(o => o.id === defaultStyleId)
  const styleMissing = styleUnknown && styleOptionsKnown
  const builtinStyles = styleOptions.filter(o => !o.mine)
  const mineStyles = styleOptions.filter(o => o.mine)

  /** ★ 2026-10-11：右列「剩余 >99.9%」那行的字（三档规则全在 `restPctLabel` 里）。
      只有 `ready` 时给字；loading / 拿不到都是**空串** —— 那一行整个不渲染，不许编一个数
      （同上面 `Usage` 那段）。⚠️ 判 `=== 'ready'`（不能写 `!== 'loading'`）：剩下那一支
      还带着 `unavailable`，`bytes` 在它身上不存在 —— 那是 typecheck 才能看见的红。 */
  const restLabel = usage.state === 'ready' ? restPctLabel(usage.bytes / usage.limit) : ''
  const modelSummary = models === null
    ? null
    : window.pinkroseDesktop && !models.some(model => model.active)
      ? '未配置'
      : modelValue(models)

  return (
    <div className="account">
      {/* ★★ 2026-10-04（晚）：用户说「布局看着都不合理」→ 第一次有了标题 + 一张列表卡。
          ★ 2026-10-05：他又说「**因为整体的空间还有很多空余，所以我想设计成一个个小框架**」
          → 一列窄卡通吃改成**三个小框架排一行**（一类一框：账号 / 模型配置 / 作品空间用量），
          把右边空着的地方用起来。他在画板上看过的样子：
          `.superpowers/brainstorm/430-1791133449/content/account-tiles.html`。
          （窄屏当时靠网格自己叠：中屏两列、手机一列。）
          ⚠️ 展开的表单 / 确认跟着**所在的那一组**走（改密码、注销都在「账号」组里往下长）。

          ★★ 2026-10-09：用户说「**我感觉这整个页面的排版都很突兀，因为空间太大而我们
          现在功能很少，优化一下**」。量出来的病根不在"几格"，在**没有宽度上限**：
          `auto-fit + 1fr` 在宽屏上把每一格拉到三分之一屏宽 —— 1800 的窗口上
          **一格 537px、里面只有两行字**（「模型配置」那格 537×87）。格子越宽、
          里面越空，"空间太大"就是它。
          → 外面套一层 `.account-inner` 收住宽度（那一版收的是 1200 —— 三格并排
          各约 381px 要的宽度）。**这一层是从"死代码"重新长回来的**：
          2026-10-04 那版（720px）当年确实没事干（里面有张 420 的窄卡）。

          ★★ 2026-10-11（**终版：单列分组**）：用户说「**设置页看起来很业余很散漫**」
          → 真机体检（`.superpowers/scratch/design-audit/report.md`）确认了观感，
          病根是**版式选错了**（设计 §一）：三格并排是"仪表盘"排版，而三块内容量
          差五倍（账号 3 行 / 模型 1 行 / 用量一整张 300px 高的大饼图），同排并列必然
          高低参差；「退出登录」还孤零零悬在左下角、底下大片空白；1200 的版心装这点
          内容本来就太大。
          → **并排退役，改单列分组**：版心收到 680px 居中（`styles.css` 的
          `.account-inner`），一类一组往下排（`.account-grid` 从网格改回一列 flex）；
          用量那一组横过来 —— 饼在左、百分比和「N 张作品」竖排右列（`.usage-copy`），
          窄屏自然叠回上下。锚点类一个没动（`App.account.test.tsx` 那串）。 */}
      <div className="account-inner">
          <h1 className="account-title">个人设置</h1>

        <div className="account-grid">
          {/* ① 「账号」框：我是谁 + 账号安全那两件 */}
          <section className="account-tile">
            <h2 className="account-tile-title">
              {window.pinkroseDesktop ? '本机资料' : '账号'}
            </h2>
            <div className="account-card">
              {/* 用户名：设置页的第一行十有八九就是"你是谁"，所以它排在最上面。

                  ★ 2026-10-09（用户原话：「像有些功能对应的增删改查的操作的补充就
                  不要再让我一再强调了，比如用户名的修改功能」）：这一行**从只读
                  变成可点**（原来是个 `<div className="account-row-static">`，
                  名字只能看、不能改）。形状照这一页「模型 ›」那一行，
                  点开就地长出一个表单 —— 全站没有弹窗文化。

                  ⚠️ `.account-label` / `.account-name` 这两个类**是测试的锚点，
                  改版也不许删**：`App.account.test.tsx` 有两条断言钉着
                  「用户名这三个字在」和「`.account-name` 恰好等于用户名」
                  （后者是防"标签被塞进名字里"的那种错法）。
                  ⚠️ 标签和名字必须**还是两个 `<span>`** —— 合成一句就撞上第二条。 */}
              {window.pinkroseDesktop ? (
                <div className="account-row-static">
                  <span className="account-row-label">使用方式</span>
                  <span className="account-row-value">无需登录</span>
                </div>
              ) : (
                <button className="account-row" aria-expanded={nameOpen}
                  onClick={() => setNameOpen((o) => !o)}>
                  <span className="account-row-label account-label">用户名</span>
                  <span className="account-row-value account-name">{user.username}</span>
                  <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} strokeWidth={1.5} /></span>
                </button>
              )}

              {/* 账号那三件（§3.6 那张图上的 改密码／注销账号，★ 加上改名）。
                  ⚠️ 「退出登录」**不在这张卡里**（见下面那颗按钮的注释）—— 它是"离开这一页"，
                  不是这一页上的一项设置，收进来就把两种东西混成一种了。 */}
              {!window.pinkroseDesktop && (
                <>
                  <button className="account-row" aria-expanded={pwOpen}
                    onClick={() => setPwOpen((o) => !o)}>
                    <span className="account-row-label">改密码</span>
                    <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} strokeWidth={1.5} /></span>
                  </button>
                  <button className="account-row account-row-danger" aria-expanded={delOpen}
                    onClick={() => setDelOpen((o) => !o)}>
                    <span className="account-row-label">注销账号</span>
                    <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} strokeWidth={1.5} /></span>
                  </button>
                </>
              )}
            </div>
            {window.pinkroseDesktop && (
              <p className="account-hint">
                软件直接打开本机资料，不需要登录。作品、会话和偏好由这份数据目录自己管理。
              </p>
            )}

            {/* 改用户名的表单（★ 2026-10-09）。⚠️ 和改密码那趟**不一样**：这一改
                **不影响登录态**（票里没有用户名），所以别在界面上写"其他设备要重新登录"。 */}
            {!window.pinkroseDesktop && nameOpen && (
              <form className="account-form" onSubmit={(e) => { e.preventDefault(); submitUsername() }}>
                {/* ⚠️ 提示**只写长度这一条**：字数是最猜不到的那条规矩，而字符类
                    写全会很长（中文、字母、数字、下划线、·）—— 长到在这一格里
                    折行、把末尾那个 `·` 孤零零甩到第二行（真机截图看过）。
                    字符类交给服务端那句「只能用中文、字母、数字、下划线和 ·」
                    （它就是注册页一直在用的那一句），别在这儿再写一遍更短的版本
                    —— 两句话不一样，用户会以为两处的规矩不一样。 */}
                <Field className="account-field" label="新用户名" hint="2 到 20 个字">
                  <TextInput name="username" autoComplete="username"
                    value={newName} onChange={(e) => setNewName(e.target.value)} />
                </Field>
                {nameMsg && <p className={nameMsg.tone === 'ok' ? 'account-msg ok' : 'account-msg'}>{nameMsg.text}</p>}
                <Btn type="submit" className="account-submit" disabled={nameBusy}>
                  {nameBusy ? '正在改…' : '改用户名'}
                </Btn>
              </form>
            )}

            {/* 改密码的表单（§6.5）。⚠️ 服务端改完会发一张新票 —— 所以这一改等于把
                **所有设备**踢下线；当前这台拿到新票、不会掉，别在界面里吓唬人。 */}
            {!window.pinkroseDesktop && pwOpen && (
              <form className="account-form" onSubmit={(e) => { e.preventDefault(); submitPassword() }}>
                <Field className="account-field" label="原来的密码">
                  <TextInput name="oldPassword" type="password" autoComplete="current-password"
                    value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
                </Field>
                <Field className="account-field" label="新密码" hint="8 位以上，别和用户名一样">
                  <TextInput name="newPassword" type="password" autoComplete="new-password"
                    value={newPw} onChange={(e) => setNewPw(e.target.value)} />
                </Field>
                {pwMsg && <p className={pwMsg.tone === 'ok' ? 'account-msg ok' : 'account-msg'}>{pwMsg.text}</p>}
                <Btn type="submit" className="account-submit" disabled={pwBusy}>
                  {pwBusy ? '正在改…' : '改密码'}
                </Btn>
              </form>
            )}

            {/* 注销的确认（§5）。⚠️ **不许只点一下就注销**：它删的是全部作品和照片。
                这句话把"删什么、能不能后悔"说全 —— 这页原来迟迟不做它，
                卡的就是这两件事没定（见 git 历史里那句「不留一个点了会出事的按钮」）。 */}
            {!window.pinkroseDesktop && delOpen && (
              <div className="account-danger">
                <p>
                  注销之后：<b>作品和照片会一起删掉</b>，账号也没了。
                  <b>删了就找不回来</b> —— 我们这边也没有备份。
                </p>
                {delMsg && <p className="account-msg">{delMsg}</p>}
                <div className="account-danger-actions">
                  <button className="account-cancel" onClick={() => setDelOpen(false)}>先不注销</button>
                  <Btn className="account-danger-submit" disabled={delBusy} onClick={confirmDelete}>
                    {delBusy ? '正在注销…' : '确认注销'}
                  </Btn>
                </div>
              </div>
            )}
          </section>

          {window.pinkroseDesktop && (
            <section className="account-tile account-storage-tile">
              <h2 className="account-tile-title">文件保存位置</h2>
              <div className="account-card">
                <div className="account-row account-storage-row">
                  <span className="account-row-label">数据文件夹</span>
                  <span className="account-row-value account-storage-path">
                    {desktopStorage.state === 'ready'
                      ? desktopStorage.path
                      : desktopStorage.state === 'loading' ? '正在读取…' : '没读到'}
                  </span>
                </div>
                <button
                  type="button"
                  className="account-row"
                  onClick={() => {
                    setDesktopMsg(null)
                    window.pinkroseDesktop?.openStorageFolder().catch(() => {
                      setDesktopMsg('文件夹打不开，请从系统文件管理器里打开。')
                    })
                  }}
                >
                  <span className="account-row-label">打开文件夹</span>
                  <span className="account-row-go" aria-hidden="true">
                    <ChevronRight size={16} strokeWidth={1.5} />
                  </span>
                </button>
                <button
                  type="button"
                  className="account-row"
                  onClick={() => {
                    setDesktopMsg(null)
                    window.pinkroseDesktop?.chooseStorageFolder().catch(() => {
                      setDesktopMsg('没有切换成功，原来的数据仍在原位置。')
                    })
                  }}
                >
                  <span className="account-row-label">更改保存位置</span>
                  <span className="account-row-go" aria-hidden="true">
                    <ChevronRight size={16} strokeWidth={1.5} />
                  </span>
                </button>
              </div>
              <p className="account-hint">
                作品、会话、原片和调色文件都在这里。更换位置时可选择复制现有数据，旧文件夹不会被自动删除。
              </p>
              {desktopStorage.state === 'unavailable' && (
                <p className="account-msg">没读到当前保存位置。</p>
              )}
              {desktopMsg && <p className="account-msg">{desktopMsg}</p>}
            </section>
          )}

          {/* ② 「模型配置」框：接自己模型那件事的入口（§7.4）。
              显示的是**别名或者「默认」**，绝不是型号（§7.3）——
              点进去是模型设置那一页（`{ kind: 'models' }`）。
              ⚠️ 那一格写别名：用户一眼认出"就是我起的那套"；写型号名不只是难读，
                 还等于把他用的是谁家摊在屏幕上。 */}
          <section className="account-tile">
            <h2 className="account-tile-title">模型配置</h2>
            <div className="account-card">
              <button className="account-row" onClick={() => onGo({ kind: 'models' })}>
                <span className="account-row-label">模型</span>
                {/* 拿不到名单时这一格整个不出现（见上面那个 effect 的注释）——
                    「默认」两个字在那种情况下是一句没根据的话。 */}
                {modelSummary !== null && <span className="account-row-value">{modelSummary}</span>}
                <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} strokeWidth={1.5} /></span>
              </button>
            </div>
          </section>

          {window.pinkroseDesktop && (
            <section className="account-tile">
              <h2 className="account-tile-title">AI 与数据说明</h2>
              <div className="account-card">
                <div className="account-row-static">
                  <span className="account-row-label">数据归属</span>
                  <span className="account-row-value">只保存在你的电脑</span>
                </div>
              </div>
              <p className="account-hint">
                PinkRose 不内置共享模型密钥，也不接收、汇总或查看你的作品和对话。AI 对话和生成式改图需要你自己接入模型服务。
              </p>
              <p className="account-hint">
                使用 AI 时，当前照片的必要预览、文字指令和必要上下文会直接发送给你配置的模型服务商；本地调色、裁剪、超清放大和导出不会上传照片。
              </p>
              <p className="account-hint">
                一次下载对应一份本机数据目录。换一台电脑或换一个数据目录时，软件不会自动带走或读取另一边的作品；请不要把自己的数据目录交给别人。
              </p>
            </section>
          )}

          {/*
            ③ 「修图偏好」（★ 2026-10-19）：默认风格 = 下一张新照片从哪套预设起手。

            ⚠️ 只影响**新打开的照片**。这一页改它时，App 那一层只写偏好，
              绝不 `setParams` —— 用户正在修的那张不能因为设置而跳色。
            ⚠️ 文案把边界说清（"下一张"），否则用户会以为当前这张也会跟着变。
          */}
          <section className="account-tile">
            <h2 className="account-tile-title">修图偏好</h2>
            <div className="account-card">
              <label className="account-row account-style-row">
                <span className="account-row-label">默认风格</span>
                <select
                  className="account-select"
                  aria-label="默认风格"
                  value={defaultStyleId ?? ''}
                  disabled={styleBusy}
                  onChange={(e) => chooseDefaultStyle(e.target.value)}
                >
                  <option value="">不预设（原图起手）</option>
                  {builtinStyles.length > 0 && (
                    <optgroup label="内置风格">
                      {builtinStyles.map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                  )}
                  {mineStyles.length > 0 && (
                    <optgroup label="我的预设">
                      {mineStyles.map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                  )}
                  {styleMissing && (
                    <option value={defaultStyleId!}>这套预设已不存在</option>
                  )}
                  {styleUnknown && !styleOptionsKnown && (
                    <option value={defaultStyleId!}>正在读取我的预设…</option>
                  )}
                </select>
              </label>
              <div className="account-row account-appearance-row">
                <span className="account-row-label">界面外观</span>
                <div className="account-appearance-choices" role="group" aria-label="界面外观">
                  {([
                    ['dark', '深色'],
                    ['light', '浅色'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`crop-chip${appearance === value ? ' on' : ''}`}
                      aria-pressed={appearance === value}
                      disabled={appearanceBusy}
                      onClick={() => chooseAppearance(value)}
                    >{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <p className="account-hint">
              只用于下一张新打开的照片；正在编辑的这张不会变。相机拍到的新照片也会按它起手。
            </p>
            <p className="account-hint">
              修图界面默认深色，减少环境光对颜色判断的影响；浅色适合白天、投影或系统本身偏亮的场景。
            </p>
            {styleMsg && <p className="account-msg ok">{styleMsg}</p>}
            {appearanceMsg && <p className="account-msg ok">{appearanceMsg}</p>}
          </section>

          <section className="account-tile">
            <h2 className="account-tile-title">长期偏好</h2>
            <div className="account-card">
              <div className="account-row account-memory-row">
                <span className="account-row-label">跨会话记忆</span>
                {memory.state === 'ready' ? (
                  <button
                    type="button"
                    className={`crop-chip${memory.value.enabled ? ' on' : ''}`}
                    aria-pressed={memory.value.enabled}
                    disabled={memoryBusy}
                    onClick={chooseMemoryEnabled}
                  >
                    {memory.value.enabled ? '已开启' : '已关闭'}
                  </button>
                ) : (
                  <span className="account-row-value">
                    {memory.state === 'loading' ? '正在读取…' : '没读到'}
                  </span>
                )}
              </div>
              {memory.state === 'ready' && memory.value.summary && (
                <p className="account-memory-summary">{memory.value.summary}</p>
              )}
              {memory.state === 'ready' && !memory.value.summary && (
                <p className="account-memory-empty">还没有记下长期偏好。</p>
              )}
              {memory.state === 'unavailable' && (
                <div className="account-memory-actions">
                  <span>没读到长期偏好。</span>
                  <button type="button" className="account-cancel" onClick={loadMemory}>再试一次</button>
                </div>
              )}
              {memory.state === 'ready' && memory.value.summary && !memoryClearAsk && (
                <div className="account-memory-actions">
                  <button
                    type="button"
                    className="account-memory-clear"
                    disabled={memoryBusy}
                    onClick={() => setMemoryClearAsk(true)}
                  >
                    清除长期偏好
                  </button>
                </div>
              )}
              {memoryClearAsk && (
                <div className="account-memory-actions">
                  <span>清除后，以后不会再按这些习惯配合。</span>
                  <button type="button" className="account-cancel" onClick={() => setMemoryClearAsk(false)}>
                    先不清
                  </button>
                  <Btn className="account-danger-submit" disabled={memoryBusy} onClick={confirmClearMemory}>
                    {memoryBusy ? '正在清除…' : '确认清除'}
                  </Btn>
                </div>
              )}
            </div>
            <p className="account-hint">
              只记录你明确要求以后长期遵守的修图偏好；可随时关闭或清除。
            </p>
            {memoryMsg && (
              <p className={memoryMsg.tone === 'ok' ? 'account-msg ok' : 'account-msg'}>
                {memoryMsg.text}
              </p>
            )}
          </section>

          {/* ④ 「作品空间用量」框（§3.6 / §6.6）。**拿不到就整个框不出现** ——
              见上面 Usage 那段（不能说成"0"，也不能画一个空壳子）。
              ⚠️ 原来行首那个「使用情况」标签删了：这一框的小标题就是它，
              同一个意思不说两遍。 */}
          {usage.state !== 'unavailable' && (
            <section className="account-tile">
              <h2 className="account-tile-title">作品空间用量</h2>
              <div className="account-card">
                {/* ★ 2026-10-05：用量饼图（用户：「这一整块都可以先放作品用量，
                    用那个立体的大一点的圆盘图表表示」→ 看完圆环后又补
                    「我想到了就是磁盘用量是一个叫做饼图的」→ 换成实心饼图）。
                    盘 `aria-hidden`：语义真值在数字里，它是"画给人看"的那份。

                    ★ 2026-10-11（单列版式）：从"饼居中在上、数字在下面居中"改
                    **横排** —— 饼在左，百分比 + 「N 张作品」竖排右列（`.usage-copy`，
                    见 styles.css 那段）。饼组件内部（几何 / 配色 / 两条压图标签）
                    一个字没动。
                    ⚠️ `usage-pie-warn` 现在**也挂到这一层**：百分比那行从饼里搬进
                    右列之后，不再是被饼包着的后代 —— 不挂到一个共同祖先上的话，
                    `.usage-pie-warn .usage-pie-pct`（用到八成整行变红）永远匹配不上。 */}
                <div className={usageWarn ? 'usage-figure usage-pie-warn' : 'usage-figure'}>
                  {/* ★ 2026-10-05（第六轮）：两个数**画进图形里**了（用户：「也要在图形中
                      展现出来」）—— `used`/`rest` 由页面用 `formatSize` 算好传进去；
                      拿不到时（loading）不传，图上占位「…」。外面那行图例因此撤了
                      （同一组数字不说两遍），stats 只剩「N 张作品」。
                      ★ 第八轮：「总共」换成「剩余」（用户：「我觉得应该显示剩余用量吧？」
                      —— "还能存多少"才是行动信息；总共 = 已用 + 剩余，可推）。 */}
                  <UsagePie
                    pct={usage.state === 'loading' ? null : usage.bytes / usage.limit}
                    warn={usageWarn}
                    used={usage.state === 'loading' ? undefined : formatSize(usage.bytes)}
                    rest={usage.state === 'loading' ? undefined : formatSize(Math.max(0, usage.limit - usage.bytes))} />
                  {/* ★ 2026-10-11：右列 —— 百分比那行（`restPctLabel` 说了算，和饼里
                      那两条标签同一套数）+「N 张作品」。loading 时百分比那行**整个
                      不渲染**（空串），只留 stats 的「…」占位。 */}
                  <div className="usage-copy">
                    {restLabel !== '' && <span className="usage-pie-pct">剩余 {restLabel}</span>}
                    <div className="account-stats">
                      {usage.state === 'loading' ? (
                        // 占位用「…」不用 0：这一格马上就会被真数替掉，而"0"读起来是关于
                        // 用户资产的**一句断言**，哪怕只闪半秒也不该是假的。
                        <div className="stat"><b>…</b><span>张作品</span></div>
                      ) : (
                        <div className="stat"><b>{usage.count}</b><span>张作品</span></div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* ★ 2026-10-04（§6.6）：用到 80% 就**主动说** —— 不能等用户存不进去了才告诉
                  他"满了"（那一刻他正想保存，等于把他堵在门口）。张数才有感觉，
                  "80%"没有；出路跟着给（一句话 + 一条直通作品集的路）。
                  ⚠️ 每张按 2 MB 估：spec 自己写的是「5 GB（约 2500 张）」。这是个**估**，
                  所以文案说的是"还能存**约**"。 */}
              {usageWarn && usage.state === 'ready' && (
                <p className="account-quota-warn">
                  空间用了八成往上，还能存约 {Math.max(0, Math.floor((usage.limit - usage.bytes) / (2 * 1024 * 1024)))} 张 ——{' '}
                  <button className="account-quota-go" onClick={() => onGo({ kind: 'gallery' })}>去作品集删几张</button>
                </p>
              )}
            </section>
          )}

          {/* ★★ 2026-10-06（深夜）：这里原来还有第 4 格「调色素材」（一个 Lut 入口）。
              用户：「**这个可以从设置里面去掉了，我们的导航栏已经有了**」——
              左栏那一支（`Nav.tsx` 的「Lut」）去的是同一个 `kind: 'luts'`，
              两个入口摆着，用户还得先判断"这俩是不是一个地方"。**撤了。**
              ⚠️ 别再加回来：同一件事的入口**只有一个出处**（和"回到这一步"、
                 「你在这里」那两颗提示同一个道理）。 */}
        </div>

        {!window.pinkroseDesktop && (
          <button
            className="account-signout"
            disabled={leaving}
            onClick={() => {
              setLeaving(true)
              // 退出用 `api/account.ts` 里那个现成的 `logout()` —— 「会话在 cookie 里、
              // 由哪一条路去清」只有那一处说了算，别在界面里再拼一次同样的请求。
              // 失败也放人走：退出是幂等的、服务端只清一个 cookie，而用户要的是离开。
              // 变异：删掉这个 `.catch` → 「请求失败也要放人走」那条测试会红
              //      （`.then(onSignedOut)` 挂在一条已经 reject 的链上，永远不会执行）。
              logout().catch(() => {}).then(onSignedOut)
            }}
          >{leaving ? '正在退出…' : '退出登录'}</button>
        )}
      </div>
    </div>
  )
}

/**
 * 「模型」那一行右边那几个字：**在用那几套的别名**，一套都没接时写「默认」。
 *
 * 两个类别各自独立（§7.4），所以他可能"对话接了、图片没接" —— 那种情况写一个
 * 别名就够了，写「默认」是错的（有一半不是默认）。两边都接了就把两个别名都写上，
 * 用顿号分开：这一格回答的是"我现在用的是哪几套"，少写一套他就要点进去核对。
 *
 * 同一个别名只写一次（两栏各存一套同名的是常事，写两遍像出了错）。
 * 导出只是为了单测能直接钉这三档。
 */
export function modelValue(configs: PublicConfig[]): string {
  const aliases = [...new Set(configs.filter((c) => c.active).map((c) => c.alias))]
  return aliases.length > 0 ? aliases.join('、') : '默认'
}

/**
 * 用量饼图 · **3D 立体版**（★ 2026-10-05 第三版。演化全记在这：
 * 「磁盘用量可视化一下用圆盘表示」→ 圆环（`2027260`）→「立体的大一点的圆盘图表」
 * → 放大 + 平面饼图（`5ab0b50` / `c2c3123`）→ 用户发来一张 Excel 的 3D 饼图说
 * 「**第二个图是我想要设计的样子**」—— 平面版在 0.x% 时是一整块灰盘、像坏了，
 * 他想要的是**斜俯视、有厚度、每块有颜色**的那种立体饼）。
 *
 * 形状：顶面是压扁的椭圆（rx 48 / ry 28），侧壁是向下 16 的厚度 —— 像一块圆蛋糕。
 *   ① 已用：顶面薄荷（渐变）+ 侧壁深青（`--pie-used-side`）+ 一圈发光；
 *   ② 剩余：顶面**明亮的蓝**（`--pie-rest` —— 2026-10-05 第五轮从深青灰换来的，
 *      用户对深青灰的判断是「没彩色」）、侧壁再暗一档（`--pie-rest-side`）——
 *      顶面亮、侧面暗是"光照"的常识做法。
 * 几何全部来自 `pie3dPaths`（采样成折线，不用 SVG 弧命令 —— 没有 large/sweep
 * 那对标志位可以写错，这是上一版真机抓过 bug 的地方）。
 *
 * ★ 2026-10-05（第六轮）：「已用 / 总共」两个数**画在图形里**（用户看完图例版说
 *   「**也要在图形中展现出来**」）—— 上下各一条小标签，色点对上饼的两块。
 *   为什么是 HTML 标签不是 SVG `<text>`：svg 整体是 `aria-hidden` 的"画面"，
 *   文字进 DOM 才读得到（这两个标签就是这页用量信息的可读副本）。
 *
 * `pct === null` = 还在取：画一块**没有切角的完整厚饼**、数字全占位「…」
 *（「0%」对着一个存过东西的人是一句假话 —— 见上面 `Usage` 那段）。
 *
 * ★★ 2026-10-05（第七轮，用户：「图形中要展示出来，**比如我已经用掉的部分就
 *   转化为另一个颜色**」）：真比例有一个死角 —— 0.3% 画出来是**一根看不见的针**
 *   （连说三轮"图上没有已用"）。修法：**最小可见角** —— 小于 5° 的占比按 5° 画，
 *   让"已用"至少是一块看得见的小楔形。
 *   ⚠️ 这是**可见性下限**，不是数据造假：图上所有数字（已用 X / 总共 Y / 百分比）
 *     一个字都没动，扇形只是一块"放大到看得见的最小色块"。
 *   ⚠️ 第七轮曾给楔形末端加过"珠子"（更醒目的视觉锚点），被用户否掉：
 *     「这上面有一个大圆圈也不好看呀」—— 极小占比时它像一颗图钉戳在盘上。
 *     **别再加圆点/珠子这类末端装饰**：楔形本身就是饼图的语言。
 *
 * ⚠️ 百分比那行**不在这个组件里了**（★ 2026-10-11：单列版式把它挪进了右列
 *   `.usage-copy`，格式化在导出的 `restPctLabel` 里、由页面调 —— 这里只剩饼和
 *   两条压图标签。那段"先补主语 → 翻成剩余视角 → 整整一行一个款式"的演化史
 *   跟着搬去了 `restPctLabel` 的注释）。
 */
export const MIN_SLICE_RATIO = 5 / 360

export function UsagePie({ pct, warn, used, rest }: {
  pct: number | null; warn: boolean
  /** 「已用 X」的说法（页面用 `formatSize` 算好传进来）；不传 = 还没拿到，占位「…」。 */
  used?: string
  /** 「剩余 Y」同理（★ 第八轮：原来是「总共」，用户「我觉得应该显示剩余用量吧？」
      —— 对，"我还能存多少"才是行动信息；总共没丢，等于已用 + 剩余，可推）。 */
  rest?: string
}) {
  const ratio = pct === null ? null : Math.max(0, Math.min(1, pct))
  // 画扇形用的占比：真比例外面套一道"可见性下限"（0 除外 —— 一点没用就是没有）。
  const drawRatio = ratio === null || ratio <= 0 ? 0 : Math.max(ratio, MIN_SLICE_RATIO)
  // loading（ratio === null）画 pie3dPaths(0)：整块厚饼、没有扇形。
  const g = pie3dPaths(drawRatio)
  return (
    <div className={warn ? 'usage-pie-wrap usage-pie-warn' : 'usage-pie-wrap'}>
      <svg className="usage-pie" viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          {/* ⚠️ id 固定 —— 这一页同时只会有一个饼图（真出现第二个再加 useId） */}
          <linearGradient id="usagePieGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            {warn ? (
              <stop offset="0%" className="ring-stop-danger" />
            ) : (
              <>
                <stop offset="0%" className="ring-stop-hi" />
                <stop offset="100%" className="ring-stop-lo" />
              </>
            )}
          </linearGradient>
        </defs>
        {/* 画序即层序（画家算法）：两张侧壁 → 两张顶面。
            侧壁先画（在顶面"下面"），剩余顶面盖住圆心的楔形，已用顶面最后压上。 */}
        {g.restSide && <path className="usage-pie-rest-side" d={g.restSide} />}
        {g.usedSide && <path className="usage-pie-used-side" d={g.usedSide} />}
        {g.restTop && <path className="usage-pie-rest-top" d={g.restTop} />}
        {g.usedTop && <path className="usage-pie-used-top" d={g.usedTop} fill="url(#usagePieGrad)" />}
      </svg>
      {/* 图上的两条标签（绝对定位：已用贴饼顶、总共贴饼底 —— 见组件头注释） */}
      <span className="usage-chart-tag usage-chart-used">
        <i className="usage-chart-dot usage-chart-dot-used" aria-hidden="true" />
        已用 <b>{used ?? '…'}</b>
      </span>
      <span className="usage-chart-tag usage-chart-rest">
        <i className="usage-chart-dot usage-chart-dot-rest" aria-hidden="true" />
        剩余 <b>{rest ?? '…'}</b>
      </span>
    </div>
  )
}

/**
 * 右列那行「剩余 N%」的格式化（★ 2026-10-11：**从 `UsagePie` 里搬出来的** ——
 * 单列版式（设计 §一）把这一行从饼下面挪进了右列 `.usage-copy`，和「N 张作品」
 * 做一竖排，所以它不再住在组件里，由页面调）。
 *
 * 规则**一个字没动**，演化史照搬（★ 2026-10-05 第九/十轮）：显示的是**剩余率**
 *（用户先看到裸着的「<0.1%」说「这个数字你得告诉用户是什么呀」，补了「已用」
 * 前缀；接着又说「**这不还是用的量不是剩余量呀**」—— 他要看**剩余**的视角：
 * "还剩多少"才是他打开这页的问题，已用是答完之后的余数）。
 * 第十轮：「剩余」和数字**并成一行**（用户：「字体和颜色应该跟数字保持一致吧
 * 看着好别扭」—— 小灰标签贴大数字的混搭他不认，整行 22px 一个款式；
 * warn 时也整行一起红，见 styles.css 的 `.usage-pie-pct`）。
 *   · 剩余 >99.95% 写「>99.9%」—— 四舍五入成「100.0%」对着一个存过东西的人
 *     就是"一个字节都没存"的假话；诚实上限写法，和以前「<0.1%」互为镜像；
 *   · 90~99.9 一位小数；其余取整；真的全满时是「剩余 0%」—— 那是真话，
 *     不是「0.0%」那种假话。
 *（读屏读出来是「剩余 99.7%」那一整句。）
 *
 * `ratio === null`（还没拿到）回**空串** —— 那一行整个不渲染，不许编一个数
 *（同「0 张作品」那条：宁可少说一句，不说一句假的）。
 */
export function restPctLabel(ratio: number | null): string {
  if (ratio === null) return ''
  const restPct = Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(1, ratio)) * 100))
  return restPct > 99.95 ? '>99.9%'
    : restPct > 90 ? `${restPct.toFixed(1)}%`
    : `${Math.round(restPct)}%`
}

/**
 * 3D 饼的几何参数。斜俯视：顶面椭圆 ry/rx ≈ 0.58，厚度 16 —— 数值都是拿真机
 * 截图调过的观感档（比例太扁像飞盘、太厚像罐子）。
 * 版面：宽 96（60±48）、高 24~96（52−28 → 52+28+16），120 的正方形里上下留白均匀。
 */
const PIE3D = { cx: 60, cy: 52, rx: 48, ry: 28, h: 16 } as const

/** 顶面椭圆上参数角 t 的点；t 增大 = 屏幕顺时针（y 向下，和一版的圆一致）。 */
function piePoint(t: number, yShift = 0): string {
  const x = (PIE3D.cx + PIE3D.rx * Math.cos(t)).toFixed(2)
  const y = (PIE3D.cy + PIE3D.ry * Math.sin(t) + yShift).toFixed(2)
  return `${x} ${y}`
}

/** [t1, t1+span] 的采样角（含首尾、约 2° 一步、最少两点）。 */
function arcAngles(t1: number, span: number): number[] {
  const n = Math.max(2, Math.ceil((span / (2 * Math.PI)) * 180))
  return Array.from({ length: n + 1 }, (_, i) => t1 + (span * i) / n)
}

/** 顶面扇形：圆心 → 沿弧一串折线点 → 闭合。 */
function topPath(t1: number, span: number): string {
  const pts = arcAngles(t1, span).map((t) => `L${piePoint(t)}`)
  return `M${PIE3D.cx} ${PIE3D.cy} ${pts.join(' ')} Z`
}

/**
 * 侧壁：弧上落在**屏幕下半**（sin t > 0 —— 即椭圆下半沿）的段，向下挤出厚度 h。
 * 上半沿的"壁"被顶面自己挡住，不用画。
 * 段可能有一到两截（弧穿越 3 点/9 点时被切开），所以返回的是一串子路径。
 * 单点的段（弧刚好擦过下半沿）挤不出面，跳过。
 */
function sidePath(t1: number, span: number): string | null {
  const segs: number[][] = []
  let cur: number[] = []
  for (const t of arcAngles(t1, span)) {
    if (Math.sin(t) > 1e-9) cur.push(t)
    else if (cur.length) { segs.push(cur); cur = [] }
  }
  if (cur.length) segs.push(cur)
  const parts: string[] = []
  for (const seg of segs) {
    if (seg.length < 2) continue
    const down = seg.slice(1).map((t) => `L${piePoint(t)}`)
    const back = [...seg].reverse().map((t) => `L${piePoint(t, PIE3D.h)}`)
    parts.push(`M${piePoint(seg[0])} ${down.join(' ')} ${back.join(' ')} Z`)
  }
  return parts.length ? parts.join(' ') : null
}

export type Pie3dPaths = {
  restTop: string | null
  restSide: string | null
  usedTop: string | null
  usedSide: string | null
}

/**
 * ratio（已用占比）→ 四张 path（导出给测试钉几何，和 `formatSize` 同一个用途）。
 *
 * 12 点起笔顺时针切 ratio 圈；剩余的部分从切点接着走完。
 * `ratio <= 0` → 扇形不画（整块饼都是"剩余"色）；`ratio >= 1` → 反过来。
 */
export function pie3dPaths(ratio: number): Pie3dPaths {
  const r = Math.max(0, Math.min(1, ratio))
  const T1 = -Math.PI / 2            // 12 点
  const spanUsed = r * 2 * Math.PI
  const spanRest = 2 * Math.PI - spanUsed
  const has = (span: number) => span > 1e-6
  return {
    usedTop: has(spanUsed) ? topPath(T1, spanUsed) : null,
    usedSide: has(spanUsed) ? sidePath(T1, spanUsed) : null,
    restTop: has(spanRest) ? topPath(T1 + spanUsed, spanRest) : null,
    restSide: has(spanRest) ? sidePath(T1 + spanUsed, spanRest) : null,
  }
}

/**
 * 体积的说法（§3.6 那张图上写的是「342 MB」）。
 *
 * 三档各取一个单位、**不显示多余的小数**：这一格回答的是"我存了多少东西"，
 * 不是"还剩几个字节"，多出来的小数位只会让人多读一眼。GB 才留一位 ——
 * 1.5 GB 和 1.9 GB 差着半个 G，那一位是真有信息的；342 MB 那一位就没有。
 *
 * 导出只是为了让测试把三档各钉一句（§3.6 那张图只画了 MB 那一档）。
 */
export function formatSize(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
