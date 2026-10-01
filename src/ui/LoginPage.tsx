import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { login, signup } from '../api/account'
import logoMark from '../assets/logo/rose.svg'
import { Field, TextInput } from './kit/Field.tsx'
import { Btn } from './kit/Btn.tsx'
import { normalizeUsername, checkUsername, checkEmail, checkPassword } from '../../shared/account.ts'
import { NAME_REQUIRED, UNEXPECTED_FAILURE } from '../../shared/copy.ts'

/** `onDone` **不带参数**，但要 **await 它** —— 它交出去的是"App 去问一次
 *  `/api/me` 拿真身"这件事，而登录页的「稍等…」要盖住整个过程（见下面 finally）。
 *
 *  为什么不回传一个 username、让 App 拼一个 `{ id: 0, ... }`：那个 id 不是任何一个
 *  真 id，是内存里的一个假人 —— 之后谁拿它去对号（收藏、历史…）都会静默地串到别人头上。
 *
 *  它**永不 reject**：App 那边是 `me().then(setUser)`，而 `me()` 的契约是
 *  401 → 返回 null、任何失败都不抛（见 api/account.ts）。所以下面那条 await
 *  不会把用户送进 catch；真要有哪天它抛了，也只是显示一句错误然后照常复位。
 */
type Props = { onDone: () => Promise<void> }

/** 密码格右边那颗小眼睛的两个形状。
 *
 *  ⚠️ **2026-10-01 起理由改了**：原来这里写的是"内联 SVG，不是图标库，
 *  因为 `dependencies` 永远只有 piexifjs / react / react-dom"—— 那条零新依赖的
 *  规矩被用户推翻了（「通用交互件一律用现成的组件库」，
 *  见 docs/superpowers/specs/2026-10-01-frontend-component-library.md）。
 *  这两只眼睛**已经排进"换成 lucide"那一批**，换掉之前先别再加新的手绘图标。
 *
 * ⚠️ 哪张图代表哪个状态，是**有约定但没有共识**的（搜一下就有三个真实的讨论：
 * 「我的眼睛按钮反了：该显示的时候变成了隐藏」、「Material Design 里密码切换图标
 * 是反的」、「两个状态下长得一样（bug）」）。所以这里选的那条标准是：
 *
 *   **图说的和 `title` / `aria-label` 说的是同一件事 —— 点下去会发生什么。**
 *
 * 藏着的时候（默认）画一只睁开的眼睛 = "点一下就能看见"；露着的时候画划掉的眼睛 =
 * "点一下收回去"。这同时是 Chrome 自带那颗显示按钮的口径，用户最可能见过它。
 * 反过来画也不是错（两条口径都真实存在）—— 但**图和字必须同口径**，
 * 而且**不能只靠图标**：这一格此刻是不是明文，最硬的指示器是密码框自己
 * （圆点 = 藏着，明文 = 露着），眼睛长什么样从来不是唯一的信号。 */
function EyeIcon() {
  // ★ 2026-10-01：换成 lucide 的图标。原来是自己画的内联 SVG，理由写在上面的
  //   注释里 —— 那条（"零新依赖"）已经被用户推翻。**换的只是画法**：
  //   哪张图代表哪个状态、`aria-label` 说什么，一个字都没动。
  //   `strokeWidth` 给 1.7（不是默认的 2）：这是原来那两笔画出来的粗细，
  //   换库之后视觉上不该有一丝变化。
  return <Eye size={18} strokeWidth={1.7} className="login-eye-icon" aria-hidden="true" />
}

/** 划掉的那只眼睛（= 点下去把密码收回去）。见上面那段"哪张图代表哪个状态"。 */
function EyeOffIcon() {
  return <EyeOff size={18} strokeWidth={1.7} className="login-eye-icon" aria-hidden="true" />
}

/** 「这一格必填」那个星号 —— 外加它的**可读等价物**（2026-09-25 用户要的）。
 *
 *  为什么分成两个 `<span>`：一个**光秃秃的** `<span>*</span>` 对读屏的人等于没说 ——
 *  念出来就是一个孤零零的"星号"，听的人既不知道它是什么意思，也不知道它在修饰哪一格。
 *  所以：
 *    · `*` 自己挂 `aria-hidden="true"`（它是**给眼睛看的**记号，没有语义），
 *      不进名字计算 —— 否则读屏的人会听到"名字 星号 （必填）"，多一个没意义的音节；
 *    · 旁边那份「（必填）」走 `.login-sr`：屏上**看不见**（1px、裁掉），但它在
 *      可访问性树里活着，于是那一格的可读名字是「名字（必填）」。
 *
 *  ⚠️ **它只挂注册页那三格**（2026-09-26 用户拍板，原话：「登录页的密码和账户
 *  不用加"*"」）。道理是"必填"在登录页上是**废话** —— 不填根本登不进去；那个记号
 *  本来是**注册表单**的约定（注册时你可能有得选）。所以三处调用都得写成
 *  `{mode === 'signup' && <Req />}`（名字 / 密码 / 邮箱，前两格是同一个组件两种长相）。
 *  `App.test.tsx` 里那条「星号只属于注册页」**两个方向都钉着** —— 登录页多出来
 *  会红、注册页少一个也红。
 *
 *  为什么不用 HTML 的 `required` 属性来代替：那个属性会让浏览器用它**自己语言**
 *  的气泡抢先弹出来（桌面 Chrome 是英文的 "Please fill out this field."），
 *  而本仓库的提示是**自己写的、中文的、就地显示的**（`checkUsername` / `checkEmail` /
 *  `checkPassword` 各自那几句）—— 等于把用户看得懂的话换成看不懂的。
 *  `App.test.tsx` 里那条「星号只属于注册页」最后一句钉着"没人把 required 加回来"。
 *
 *  颜色**故意不是红的**：那个红（`--danger`）是**错误**的颜色，见 styles.css
 *  里 `.login-error` 那段注释 —— 一个空着的必填格不是错误，只是还没填。 */
function Req() {
  return (
    <>
      <span className="login-star" aria-hidden="true">*</span>
      <span className="login-sr">（必填）</span>
    </>
  )
}

/**
 * 登录 / 注册。**这是打开产品看到的第一屏**，所以它自己被产品规则约束着：
 * 一行一句人话、错了说清为什么、正在忙的时候按钮不能重复点。
 */
export function LoginPage({ onDone }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  /** 密码那一格此刻是不是**看得见**（明文）。见下面那一格的注释。 */
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // 闸门：不挡的话，用户等不及连点两下就是两次注册尝试 ——
    // 第二下会撞上"这个名字已经有人用了"，而它明明是自己刚注册的。
    if (busy) return
    setError(null)

    // 名字先归一化 —— **登录和注册都要这一步**：他打 `Admin` 得能找到 `admin`，
    // 打 U+30FB 的中点得能找到半角那个。就是 shared/account.ts 里抽出来的
    // `normalizeUsername`；少了它，一个已经存在的账号用户照着打都进不去。
    const normalized = normalizeUsername(username)
    if (normalized.length === 0) return setError(NAME_REQUIRED)

    // ⚠️ **下面这一段（长度、字符类、保留名、密码至少 8 位、密码不能和名字一样）
    // 是「能不能拿这个名字开号」的规矩，只属于注册。**
    //
    // 登录要问的是另一件事：名字在不在、密码对不对 —— 那不是本地能回答的，
    // 只有库那头知道（见 server/account.ts 的 handleLogin）。
    // 在登录页上跑注册那套规矩，用户撞上的是**答非所问**的话：
    // 2026-09-25 真撞过 —— 他在登录页打 `admin` / `admin123`，屏幕上跳出
    // 「这个名字是留给官方账号的，换一个吧」，于是他问"是已经有这个账户了吗？"。
    // 那句话回答的是"能不能拿它注册"，而他要问的是"我能不能进去"，照着它
    // 一步也走不下去。所以登录这条路只做「归一化 + 非空」，其余交给服务端。
    //
    // 前端这一遍是**体验**（一边打一边知道哪不对），不是规矩 ——
    // 后端还会再验一遍，因为请求可以伪造。注册这条路照旧两边都跑。
    let name = normalized
    let pw = password
    if (mode === 'signup') {
      const u = checkUsername(username)
      if (!u.ok) return setError(u.message)
      // 值走 `u.value` 而不是上面那个 `normalized`：规矩和它归一化后的值一起给，
      // 两边将来要是分了岔（比如再加一种折叠），注册这条路仍然送的是**被验过的**
      // 那个值。
      name = u.value
      // ⚠️ `u.value` 必须传进去 —— 「密码不能和名字一样」唯一的落地处（注册这一路）。
      // 那参数是**可选**的，忘了传不会报错、不会红，只会让这条规则**静默失效**。
      // 登录那条路**不跑**这一条：那里"密码等于名字"恰恰是一个**正确**的密码
      // （有人真的就叫 admin、密码也叫 admin），拦下来等于让他登不进自己的号。
      const p = checkPassword(password, u.value)
      if (!p.ok) return setError(p.message)
      pw = p.value
    }

    setBusy(true)
    try {
      if (mode === 'signup') {
        // 邮箱只在这一条路上要。放进 busy 之后是因为它排在上面两条校验后面：
        // 名字和密码都没问题才值得提邮箱，否则用户一次只看到一条提示。
        const em = checkEmail(email)
        if (!em.ok) { setError(em.message); return }
        await signup({ username: name, email: em.value, password: pw })
      } else {
        // 密码送**原话**：它可能带空格、可能是中文，而任何一种"顺手归一化"
        // 都会让用户下次照原样敲反而登不上（见 shared/account.ts 里那条注释）。
        await login({ username: name, password })
      }
      // `await` 是**故意**的：等 App 把"我是谁"问出来，这一趟才算交棒完。
      // 不 await 的话按钮会在跟随请求还在半路时就变回可点 ——
      // 用户看到"点完按钮又从『稍等…』变回『登录』、画面什么都没发生"，
      // 那正是最容易诱发"再点一下"的形状（再点就是第二次注册/登录请求）。
      await onDone()
    } catch (err) {
      // 后端说的话（"这个名字已经有人用了"）比这里能编的任何一句都准，
      // 原样显示。**不清空任何输入框** —— 最气人的一种失败是密码输错一次、
      // 表单被清空，用户得从头再打一遍。
      setError(err instanceof Error ? err.message : UNEXPECTED_FAILURE)
    } finally {
      // ⚠️ 复位在 `finally` 里，而且因为上面那句 `await`，它只发生在
      // **跟随请求真的结束之后**。两条路各有一个坑，这个形状同时避开：
      //
      //   · 不复位（原来那样）：`onDone()` 只是让 App 去问一次 `/api/me`，
      //     而那一次失败也返回 null（服务器重启、网络瞬断），于是 App 又渲染回
      //     登录页 —— React 在同一个位置**复用组件 state**，busy 还是 true，
      //     用户看到一个**永远转下去的「稍等…」**，唯一的出路是刷新页面。
      //     一个永远转的按钮比一句报错更糟：报错至少说了"不行"，它连"不行"
      //     都没说 —— 用户不知道要不要等。
      //   · 不 await 就复位：`/api/me` 还在半路时按钮就变回可点了，见上面那句。
      //     窗口长度就是**一次 /api/me 往返**：本机是几毫秒，但真机走移动网是
      //     几十到几百毫秒、差网能到秒级 —— 不是"反正很快"就可以不管。
      //
      // 代价：失败时那个「稍等…」会多显示一次往返。那是**诚实**的 ——
      // 那段时间我们确实还在做事（在问"你是谁"）。
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-box" onSubmit={submit}>
        {/* ★ 标题**跟着模式走**（2026-09-25 用户拍板，原话：「登录页显示登录，注册页显示注册」）。

            这里原来写死的是「随心」—— 那个中文名是**写账号那一段的计划时自己起的**，
            设计文档里从来没有过（文档里一直只叫 `RuiXing`）。用户看到成品之后问
            「这个随心是啥？」，查下去查出来的就是这个来历，于是拍了这一条：
            这一屏要说的是**这一步在干什么**，那就直说。

            ⚠️ 为什么它必须跟着 `mode` 变、不能挑一个词写死：**副标题在上一轮被删掉了**
            （见下面那段），所以这一屏上能说出"现在在登录还是在注册"的只剩两处 ——
            这个标题，和下面那颗提交按钮。而提交按钮在 `busy` 的时候会变成「稍等…」，
            那几秒它**不说模式**：**忙的这几秒里，标题是屏上唯一还在说模式的字。**

            ⚠️ 它和提交按钮读的是**同一个 `mode`**、在同一次渲染里算出来，所以不忙的时候
            两处永远是同一个词。`App.test.tsx` 里「标题就说这一步是干什么的」那条
            钉着两个模式各该显示什么 —— 谁把这里写死成两选一（或写死回「随心」），
            它另一半当场红。 */}
        {/* 玫瑰标志。**放在标题上面，不替掉标题** —— 标题是要说"现在在登录还是在注册"的
            （上面那一大段讲的就是这件事），换成图片那句话就没了。
            图片 `alt=""`：它旁边就是标题和按钮，读屏的人不需要再听一遍"玫瑰"。

            ⚠️ 2026-09-25 用户把标题下面那两行字都删了，所以这一屏现在很素。
            加个标志是把那块空白用掉，不是又塞一句话回来 —— **别顺手再加副标题。** */}
        <img className="login-mark" src={logoMark} alt="" width={64} height={64} />
        <h1 className="login-title">{mode === 'login' ? '登录' : '注册'}</h1>
        {/* ⚠️ 标题下面原来有两行字，2026-09-25 用户看过页面之后**都要去掉**：
              · 副标题 `.login-sub`（登录那句「登录一下，你的图都在这儿」/ 注册那句
                「注册一个，图就留下来了」）—— 它是**两种模式共用的一个元素**，
                用户截的是注册页那半句，但删掉之后**两种模式都没有这一行了**；
              · 上一轮刚加的、解释星号的那句 `.login-hint`「打 * 的都得填」。

            ⚠️ 删掉 `.login-hint` 的**代价记在这儿**：屏上现在没有一个字解释那个
            `*` 是什么意思（`.login-star` 是给眼睛看的记号，本身不会说话）。留下的
            那一半是 `Req` 里给读屏用的「（必填）」—— 所以这件事**可访问性那一半还在，
            屏上那一半没有了**。这不是漏了，是用户拍板的：他是看到成品之后说不要的。
            ⚠️ 2026-09-26 补：**上面这一整段现在只管注册页了** —— 用户同一天又拍了
            「登录页的密码和账户不用加 *」，于是登录那两格连星号带「（必填）」一起没了。
            登录页上不再有"没人解释那个星号"这个问题（屏上压根没有星号）。
            将来谁觉得标题下面空、想加回来，先看 `App.test.tsx` 里那条
            「星号只属于注册页」—— 它两个方向都钉着。 */}

        {/* ★ ★★ 三个字段的顺序是「名字 → 密码 → 邮箱」（2026-09-25 用户拍板）。
            原来邮箱排在密码前面，用户看图说的原话是「这三个的顺序依次是账户和密码
            然后是邮箱」—— 道理是**必填的两个挨着，性质不同的那个放最后**。

            ⚠️ 顺序和下面那三个 `name=` 是**一件事的两半**，别只改一半：
            这个仓库里原来有十七处代码按"第几个框"去填这三个字段
            （`App.test.tsx` 里十处、`.superpowers/` 下的验收探针七处），谁都没写
            字段名 —— 顺序一换，它们照样是绿的，只是**全都在往错误的框里打字**
            （把邮箱打进密码格，而报错要等到服务端。这一轮真跑过对照，确认是静默绿的）。
            所以：`name="username" / "password" / "email"` 是那十七处的**新钩子**，
            而 `App.test.tsx` 里那条「三个框的先后」钉着顺序本身。

            `name` 这个属性的选择不是随手挑的：它是标准 HTML，对浏览器的密码管理器
            （它按 `name` + `autoComplete` 认哪一格是哪个）有好处，顺便才当了测试的钩子。
            `autoComplete` 那几个**一个字都没动** —— 它们按模式在
            `current-password` / `new-password` 之间分，动错了会惹那个密码管理器。 */}
        <Field className="login-field" label={<>名字{mode === 'signup' && <Req />}</>}>
          <TextInput name="username" value={username} onChange={e => setUsername(e.target.value)}
                     autoComplete="username" autoFocus />
        </Field>

        {/* ⚠️ 密码这一格外面**不是**一个把输入框包进去的 `<label>`（原来名字和邮箱
            那两格是），是有理由的：那个开关得和输入框**并排**，而 `<button>`
            也是 labelable 元素 —— 把它包进 `<label>` 里，
              · 输入框的可读名字会从「密码」变成「密码 显示」（label 的文本替代
                会一路把按钮上的字也算进去），读屏的人听到的是个自相矛盾的名字；
              · 而 label 的"点一下聚焦到它的控件"认的是**第一个** labelable 元素，
                顺序稍不留神就会点到那个按钮上去。
            所以这一格要的是"显式配对"那种结构。

            ★ 2026-10-01 起，这个结构由 `<Field>` 统一给出来（它就是
            `<div class="login-field"><label for=…>…</label> + 控件` 这个形状）——
            也就是说**三格现在是同一种写法**了，不再是"两格包着、一格配对"。
            类名照旧是 `login-field`，`.login-field input` 那几条样式和测试里的
            选择器都不受影响。

            ⚠️ 「可读名字」这件事**只在注册模式下多了一层**：那里 `<Req />` 里那份
            `.login-sr` 的「（必填）」也在这一格的 label 里，所以读屏的人听到的是
            「密码（必填）」—— 这正是要的。**登录模式下没有 `<Req />`**（2026-09-26
            用户拍板），这一格的可读名字就是干干净净的「密码」。而 `.login-sr` 那份字
            是 `display: none` **不出来的**：那种写法会把节点从可访问性树里一并删掉，
            等于没加（见 styles.css 里 `.login-sr` 那条）。 */}
        <Field className="login-field" label={<>密码{mode === 'signup' && <Req />}</>}>
          <div className="login-pw">
            <TextInput name="password" value={password} onChange={e => setPassword(e.target.value)}
                       type={showPassword ? 'text' : 'password'}
                       autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {/* ⚠️⚠️ `type="button"` 一个字都不能省。这个 `<button>` 在
                `<form className="login-box" onSubmit={submit}>` **里面** ——
                那是个**真的表单**，而表单里不写 `type` 的 `<button>` **默认就是
                `submit`**：用户想看一眼自己打对没有，点一下那颗眼睛，
                已经填好的密码会**当场被提交上去**（真的会发一次登录请求）。
                `src/App.test.tsx` 里「点那个开关不会把表单交上去」那条守着它 ——
                把 `type="button"` 删掉，那条必须红。

                `autoComplete` 一个字都没动（它按模式在 `current-password` /
                `new-password` 之间分），换错了会惹浏览器那个密码管理器。

                ★ 2026-09-25 第二轮（用户要的）：**按钮上的字换成了一只小眼睛，
                而且坐进输入框内部右侧**（原来是框外右边一颗「显示 / 隐藏」的文字
                按钮）。位置上它是 `.login-pw` 里的绝对定位子元素 —— 所以
                `.login-pw` 必须是 `position: relative`，输入框还得多留一格
                `padding-right`（见 styles.css 那两条：两样是一对，只改一样
                密码长到右边时文字就会跑到眼睛底下）。

                ★ `aria-label` **和** `title` 一起给，而且是**同一个意思**：
                · `title` 是鼠标停上去看得见的；
                · `aria-label` 是读屏的人听到的（图上没有任何字，两个都省掉的话
                  它就是一个没有名字的按钮）。
                两句话都说的是**点下去会发生什么**，而且跟着状态变 —— 那条
                测试（「那颗眼睛的"名字"必须跟着状态走」）就是给这件事兜底的：
                图标本身是猜的，文字才是说得清的。 */}
            <button type="button" className="login-eye"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    title={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword(v => !v)}>
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </Field>

        {/* 邮箱排最后（见上面那段顺序说明）。它在**登录模式下整个不渲染** ——
            注册才要它，而登录页问的只有"我是谁"。 */}
        {mode === 'signup' && (
          <Field className="login-field" label={<>邮箱<Req /></>}>
            <TextInput name="email" value={email} onChange={e => setEmail(e.target.value)}
                       type="email" autoComplete="email" />
          </Field>
        )}

        {error && <p className="login-error">{error}</p>}

        <Btn type="submit" className="login-submit" disabled={busy}>
          {busy ? '稍等…' : mode === 'login' ? '登录' : '注册'}
        </Btn>

        {/* 切换模式时清掉上一条错误：那一句说的是**另一种模式**下的事
            （"这个名字已经有人用了"在登录模式下毫无意义），留着会误导。

            框里那几个字**一并清掉**，理由是同一件事的两面：它们也是**在另一种
            模式下**打进来的，切过去之后含义就不是用户写的那句话了。最要紧的是
            密码那一格 —— 登录页上它问的是"我的密码"，注册页上它问的是"给我设的
            新密码"，所以用户在登录页手滑打错的一个字符，会在他毫不知情的情况下
            变成新账号的密码（他以为只是"切过去看一眼，再切回来"）。名字那格同理：
            登录页问"我是谁"，注册页问"我想叫什么"。留着它们不是"省用户一遍手"，
            是**替用户做主用了他没打算交出去的那几笔字**。

            密码那个「看得见」的开关也一并**关回去**：上面刚把密码清空，
            一个开着明文的空框没有任何意义，而留着它更容易被人瞄到 ——
            用户切过去之后往往还会再打一遍密码，那时它默认就该是圆点。 */}

        {/* ★ 忙的时候**不许换模式**（`disabled={busy}`，2026-09-26 补）。

            `submit` 开头那句 `if (busy) return` 管的是"同一件事的半边"：它挡的是
            用户等不及连点两下、交出去两条（注释在那儿写着"就是两次注册尝试"）。
            这是**另外半边** —— 半路换模式，会让**在飞的那条请求**和**屏上说的
            模式**对不上：用户点的是「还没有账号？注册一个」，标题当场翻成「注册」，
            可仍在半路的是那条**登录**请求；它要是失败，服务端那句关于**登录**的话
            （「没有这个账号，去注册一个吧」）会落在「注册」标题底下 ——
            用户读到一句**归错地方**的话，照着它一步也走不下去。

            ⚠️ 为什么这件事这一轮才看得见：副标题上一轮删了，提交按钮忙的时候又
            只肯说「稍等…」，所以忙的这几秒里**标题是屏上唯一还在说模式的字**
            （见上面标题那段）。以前标题写死「随心」、不参与模式，切换过去也看不出来；
            换上 `{mode === 'login' ? '登录' : '注册'}`，这种错位就成了明面上的事。

            ⚠️ 所以它和提交按钮是**同一个判断的两处落地**：那两秒里能改变模式的东西
            只有这一颗，它不挡，标题那句"唯一还在说模式的字"就等于白说。
            `App.test.tsx` 里「登录请求还在半路时，两颗按钮都得是禁用的」守着它 ——
            把 `disabled={busy}` 删掉，那条必须红。 */}
        <button type="button" className="login-switch" disabled={busy}
                onClick={() => {
                  setMode(mode === 'login' ? 'signup' : 'login')
                  setError(null)
                  setUsername('')
                  setEmail('')
                  setPassword('')
                  setShowPassword(false)
                }}>
          {mode === 'login' ? '还没有账号？注册一个' : '已经有账号了？去登录'}
        </button>
      </form>
    </div>
  )
}
