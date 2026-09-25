import { useState } from 'react'
import { login, signup } from '../api/account'
import { checkUsername, checkEmail, checkPassword } from '../../shared/account.ts'

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

/**
 * 登录 / 注册。**这是打开产品看到的第一屏**，所以它自己被产品规则约束着：
 * 一行一句人话、错了说清为什么、正在忙的时候按钮不能重复点。
 */
export function LoginPage({ onDone }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // 闸门：不挡的话，用户等不及连点两下就是两次注册尝试 ——
    // 第二下会撞上"这个名字已经有人用了"，而它明明是自己刚注册的。
    if (busy) return
    setError(null)

    // 前端这遍是**体验**（一边打一边知道哪不对），不是规矩 ——
    // 后端还会再验一遍，因为请求可以伪造。
    const u = checkUsername(username)
    if (!u.ok) return setError(u.message)
    const p = checkPassword(password, u.value)
    if (!p.ok) return setError(p.message)

    setBusy(true)
    try {
      if (mode === 'signup') {
        // 邮箱只在这一条路上要。放进 busy 之后是因为它排在上面两条校验后面：
        // 名字和密码都没问题才值得提邮箱，否则用户一次只看到一条提示。
        const em = checkEmail(email)
        if (!em.ok) { setError(em.message); return }
        await signup({ username: u.value, email: em.value, password: p.value })
      } else {
        // 密码送**原话**：它可能带空格、可能是中文，而任何一种"顺手归一化"
        // 都会让用户下次照原样敲反而登不上（见 shared/account.ts 里那条注释）。
        await login({ username: u.value, password: password })
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
      setError(err instanceof Error ? err.message : '出了点问题，再试一次')
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
        <h1 className="login-title">随心</h1>
        <p className="login-sub">{mode === 'login' ? '登录一下，你的图都在这儿' : '注册一个，图就留下来了'}</p>

        <label className="login-field">
          <span>名字</span>
          <input value={username} onChange={e => setUsername(e.target.value)}
                 autoComplete="username" autoFocus />
        </label>

        {mode === 'signup' && (
          <label className="login-field">
            <span>邮箱</span>
            <input value={email} onChange={e => setEmail(e.target.value)}
                   type="email" autoComplete="email" />
          </label>
        )}

        <label className="login-field">
          <span>密码</span>
          <input value={password} onChange={e => setPassword(e.target.value)}
                 type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>

        {error && <p className="login-error">{error}</p>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? '稍等…' : mode === 'login' ? '登录' : '注册'}
        </button>

        {/* 切换模式时清掉上一条错误：那一句说的是**另一种模式**下的事
            （"这个名字已经有人用了"在登录模式下毫无意义），留着会误导。

            框里那几个字**一并清掉**，理由是同一件事的两面：它们也是**在另一种
            模式下**打进来的，切过去之后含义就不是用户写的那句话了。最要紧的是
            密码那一格 —— 登录页上它问的是"我的密码"，注册页上它问的是"给我设的
            新密码"，所以用户在登录页手滑打错的一个字符，会在他毫不知情的情况下
            变成新账号的密码（他以为只是"切过去看一眼，再切回来"）。名字那格同理：
            登录页问"我是谁"，注册页问"我想叫什么"。留着它们不是"省用户一遍手"，
            是**替用户做主用了他没打算交出去的那几笔字**。 */}
        <button type="button" className="login-switch"
                onClick={() => {
                  setMode(mode === 'login' ? 'signup' : 'login')
                  setError(null)
                  setUsername('')
                  setEmail('')
                  setPassword('')
                }}>
          {mode === 'login' ? '还没有账号？注册一个' : '已经有账号了？去登录'}
        </button>
      </form>
    </div>
  )
}
