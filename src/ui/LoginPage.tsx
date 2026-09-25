import { useState } from 'react'
import { login, signup } from '../api/account'
import { checkUsername, checkEmail, checkPassword } from '../../shared/account.ts'

/** `onDone` **不带参数**：登录成功后要的是"真身"，而真身只有后端有 ——
 *  App 里重新问一次 `/api/me` 拿到的才是真的（id、email 都在）。
 *  让这一层回传一个 username、App 再拿它拼一个 `{ id: 0, ... }`，
 *  等于在内存里放一个**假的用户**：那个 id 不是任何一个真 id，
 *  之后谁拿它去对号（收藏、历史…）都会静默地串到别人头上。 */
type Props = { onDone: () => void }

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
      onDone()
    } catch (err) {
      // 后端说的话（"这个名字已经有人用了"）比这里能编的任何一句都准，
      // 原样显示。**不清空任何输入框** —— 最气人的一种失败是密码输错一次、
      // 表单被清空，用户得从头再打一遍。
      setError(err instanceof Error ? err.message : '出了点问题，再试一次')
    } finally {
      // ⚠️ 复位在 `finally` 里 —— **成功那一路也要复位**。直觉上"成功之后
      // 就该走了、复位不复位无所谓"，但有一条真能走到的死路：
      // `onDone()` 只是让 App 去问一次 `/api/me`，而**那一次失败也返回 null**
      // （服务器重启、网络瞬断），于是 App 又渲染回登录页 —— 而 React 在
      // 同一个位置**复用组件 state**，busy 还是 true。用户看到的是一个
      // 永远转下去的「稍等…」，唯一的出路是刷新页面。
      //
      // 一个永远转的按钮比一句报错更糟：报错至少说了"不行"，它连"不行"
      // 都没说 —— 用户不知道要不要等。复位之后最坏也只是"回到一个可以
      // 再点一次的登录页"，而用户打过的字还在。
      //
      // 代价：复位到 App 认出登录之间，按钮会短暂地亮回来（本地几毫秒）。
      // 那时再点一下会多发一次登录（幂等）或注册（会回一句"这个名字已经
      // 有人用了"）—— 比"永远卡住"轻得多。
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
            （"这个名字已经有人用了"在登录模式下毫无意义），留着会误导。 */}
        <button type="button" className="login-switch"
                onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null) }}>
          {mode === 'login' ? '还没有账号？注册一个' : '已经有账号了？去登录'}
        </button>
      </form>
    </div>
  )
}
