// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **账号那一簇**：登录这道门 + 用户管理页（含模型设置）。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import { CUBE2_TEXT, LOGGED_IN, MODEL, canvasProps, container, decision, fetchMock, goNav, jsonResponse, makeGate, renderApp, say, setMeFails, setMeGate, setMeUsage, setMeUsageGate, setMeUser, uploadPhoto, withModels, withModelsError, withUsage, withUsageError } from './test/appHarness'
import { act } from 'react'
import { MAX_LUT_FILE_BYTES, type LutMeta } from '../shared/lut.ts'
import { MIN_SLICE_RATIO, formatSize, modelValue, pie3dPaths } from './ui/AccountPage'
import * as api from './api/client'
import * as lutsMod from './api/luts'
import { describe, expect, it, vi } from 'vitest'

describe('登录这道门', () => {
  /** 往受控输入框里打字。React 靠自己的 value tracker 判断"值变没变"，
   *  直接写 `el.value` 它看不见 —— 得用原型上的 setter 绕过去再派一个 input 事件。 */
  function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** 按**字段名**取某一格 —— 2026-09-25 起不再按"第几个"。
   *
   *  ⚠️ 这一条是那次踩出来的教训，不是洁癖。三格的顺序从「名字、邮箱、密码」
   *  换成「名字、密码、邮箱」（用户拍板）时，全仓**有十七处**按位置填这几格的代码
   *  （这个文件里十处、`.superpowers/` 下的验收探针里七处），谁都没写字段名。
   *  它们**不会红** —— 填错框不是错，`type()` 照常成功、事件照常送到另一个
   *  input 上，只是那笔字进了别人的格子，而后果要等到服务端回一句"密码不对"
   *  才看得见（这一轮真跑过对照：按位置填 + 顺序换回去，那条用例**照样绿**）。
   *  所以钩子（`name` 属性）现在是唯一的取法，顺序怎么调都不影响这些测试。
   *
   *  找不到就**抛**（而不是返回 null）：调用处要的失败语气是"屏幕上少了那一格"，
   *  不是 `Cannot read properties of null` —— 后者读起来像"测试自己坏了"。 */
  function field(which: 'username' | 'password' | 'email'): HTMLInputElement {
    const el = container.querySelector<HTMLInputElement>(`.login-field input[name="${which}"]`)
    if (!el) throw new Error(`屏幕上没有 name="${which}" 那一格`)
    return el
  }

  async function fillAndSubmit(username: string, password: string) {
    // 登录模式下就两个输入框：名字、密码（按字段名取，不按"第几个"）
    const name = field('username')
    const pass = field('password')
    await act(async () => {
      type(name, username)
      type(pass, password)
    })
    const form = container.querySelector('form.login-box') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  const calledWith = (path: string) => fetchMock.mock.calls.filter(c => c[0] === path)

  /** 切到注册模式。有几条规矩（"密码至少 8 位"、"密码不能和名字一样"）**只属于注册**，
   *  要测它们就得先站到那条路上 —— 登录模式下连邮箱那一格都不渲染。 */
  async function switchToSignup() {
    const sw = container.querySelector('.login-switch') as HTMLButtonElement | null
    expect(sw).toBeTruthy()
    await act(async () => {
      sw?.click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  // ── 密码那一格的「看得见」开关（2026-09-25 加） ─────────────────────
  /** 密码那一格。
   *  ⚠️ 按**字段名**找，**不按 `[type=password]` 找** —— 这几条测试要断言的
   *  恰恰是它的 `type` 会变，拿 `type` 当锚点的话开关一按它自己就先失联了
   *  （选择器再也找不到那个元素，红得莫名其妙）。
   *
   *  这里**原来还有一个理由**：「按结构找，密码两种模式都在最后」。那个说法在
   *  2026-09-25 顺序换成「名字、密码、邮箱」之后就**不成立了** —— 注册模式下
   *  最后一个是邮箱。所以这条注释和那个取法一起改了：位置是个会变的答案。
   */
  function passwordBox(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>('.login-field input[name="password"]')
  }

  /** 点一下那个开关。按**类名**找，不按文案找。
   *  `expect(...).toBeTruthy()` 先挡一道：开关不在时要红成"少了这个控件"，
   *  而不是 `Cannot read properties of null` —— 那是"测试自己坏了"的语气。 */
  async function toggleEye() {
    const eye = container.querySelector('.login-eye') as HTMLButtonElement | null
    expect(eye).toBeTruthy()
    await act(async () => {
      eye?.click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('没登录 → 只有登录页，修图那套一个都不挂载', async () => {
    setMeUser(null)
    await renderApp()

    expect(container.querySelector('.login-box')).toBeTruthy()
    // 上传入口**不出现**：让用户先挑好照片、再在下一步撞 401，是最糟的顺序。
    expect(container.querySelector('input[type="file"]')).toBeNull()
  })

  it('登录成功 → 进得来（上传入口出现），请求也带着 cookie', async () => {
    setMeUser(null)
    await renderApp()
    await fillAndSubmit('小明', 'password123')

    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    expect(container.querySelector('.login-box')).toBeNull()

    // 会话在 cookie 里，不带 credentials 的话浏览器根本不发它 ——
    // 现象是「登录了还是用不了」，排查时很难往这里想（见 api/client.ts 那段注释）。
    const call = calledWith('/api/login')[0]
    expect((call[1] as RequestInit).credentials).toBe('same-origin')
    // 登录成功后 App 是**重新问一次 /api/me** 拿的真身，不是拿名字拼的假人
    expect(calledWith('/api/me').length).toBeGreaterThan(1)
  })

  it('⚠️ 注册模式下密码太短 → 一个请求都不发，而且说清为什么', async () => {
    // ⚠️ 这条**原来是在登录模式下测的**（那时候登录页也跑注册那套规矩）。
    // 2026-09-25 起登录不再跑它，所以这条挪回它真正的主人：注册。
    // 断言一个字没改，只换了模式 —— 它钉的是「密码至少 8 位」这条注册规矩
    // 真的接在**注册**这条路上（谁把那行 `checkPassword` 删了，这条红）。
    setMeUser(null)
    await renderApp()
    await switchToSignup()

    // 按字段名填（原来是 `boxes[0]/[1]/[2]` = 名字/邮箱/密码 —— 顺序一换就全错位）
    await act(async () => {
      type(field('username'), '小明')
      type(field('email'), 'a@b.com')
      type(field('password'), 'short')
    })
    const form = container.querySelector('form.login-box') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.textContent).toContain('密码至少 8 位')
    expect(calledWith('/api/signup')).toHaveLength(0)
  })

  it('★ 登录模式下密码太短**不拦** —— 打的是什么就是什么，对不对由服务端说', async () => {
    // 「至少 8 位」是给**新密码**定的规矩。登录时用户打的是什么就是什么：
    // 一个老账号的密码可能只有 6 位（规则改过，或者他注册得早），本地按今天的
    // 注册规矩拦下来，等于**他自己的密码永远打不进去** —— 而屏幕上那句
    // "密码至少 8 位"还会让他开始怀疑是自己记错了。
    setMeUser(null)
    await renderApp()
    await fillAndSubmit('小明', 'short')

    // ★ 变异：把登录那条路上的 `checkPassword` 加回来 → **红在这一句**
    //   （`expected [] to have a length of 1`）。
    const call = calledWith('/api/login')
    expect(call).toHaveLength(1)
    // 而且是**原话**送出去的：没被"顺手"补长、截短或者归一化（那是别人密码的一部分）。
    expect(JSON.parse(String((call[0]?.[1] as RequestInit).body)).password).toBe('short')
  })

  it('★★ 用户撞的那个 case：登录模式下打 `Admin`，屏幕上不许出现"留给官方账号"', async () => {
    // 2026-09-25 用户真撞的：他在登录页打 `admin` / `admin123`，屏幕上跳出
    // 「这个名字是留给官方账号的，换一个吧」—— **一个请求都没发出去**。
    // 那句话回答的是"能不能拿这个名字注册"，而他要问的是"我能不能进去"；
    // 他读完问的是「是已经有这个账户了吗？」。
    //
    // 这里打 `Admin`（大写）而不是 `admin`：同一个 case —— `checkUsername` 会先
    // 折小写再撞保留名 —— 顺带把**归一化**也钉住（请求体里必须是 `admin`）。
    setMeUser(null)
    await renderApp()

    // 服务端此刻的答案就是新的那一句（服务端那边有两条自己的测试钉着）。
    // 这里**故意让它失败**：不然登录成功、页面切走，就看不见"服务端那句话
    // 到底有没有到屏幕上"。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/login'
        ? jsonResponse({ error: { code: 'BAD_REQUEST', message: '没有这个账号，去注册一个吧' } }, 400)
        : inner(url, init))

    await fillAndSubmit('Admin', 'admin123')

    // ① 注册规矩的话一个字都不许出现在登录页上
    expect(container.textContent).not.toContain('留给官方账号')
    expect(container.textContent).not.toContain('官方')
    // ② 请求真的发出去了 —— 而且名字是**归一化之后**的（`Admin` → `admin`）。
    //   ★ 变异：把登录模式也加回 `checkUsername`（老代码）→ 红在①②
    //     （一个请求都没有，屏幕上还挂着"留给官方账号"）；
    //     把 `normalizeUsername` 换成原样送 `username` → 红在第②句。
    const call = calledWith('/api/login')
    expect(call).toHaveLength(1)
    expect(JSON.parse(String((call[0]?.[1] as RequestInit).body)))
      .toEqual({ username: 'admin', password: 'admin123' })
    // ③ 屏幕上出现的是**服务端那句话** —— 登录页对"名字在不在"一无所知，
    //   它只能把问题交出去，然后把答案原样摆出来。
    //   ⚠️ 这句话现在**自己带着出路**（「…去注册一个吧」，2026-09-25 用户拍板加），
    //   而下面那颗「还没有账号？注册一个」按钮**还在** —— 两处在意思上是重复的，
    //   那是用户要的重复，第四句守着"别顺手把按钮删了"。
    expect(container.querySelector('.login-error')?.textContent).toBe('没有这个账号，去注册一个吧')
    expect(container.querySelector('.login-switch')?.textContent).toContain('还没有账号')
    // 失败就是失败：还停在登录页，没有"半进去"这回事。
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('登录模式下名字是空的 → 「起个名字吧」，一个请求都不发', async () => {
    // 登录这条路上**只剩这一条**本地规矩：名字不能空 —— 空了连"查谁"都无从谈起。
    // 顺便它还是"出路"那一类：说了哪里不对，用户就知道该往哪儿填。
    //
    // 两次输入：一次真的是空的，一次只有空格。后者钉的是**先归一化、再判空**，
    // 写成 `username.length === 0` 的话它会溜过去 —— 发一条用户名是几个空格的
    // 登录请求出去，服务端只能回一句用户看不懂的话。
    setMeUser(null)
    await renderApp()

    await fillAndSubmit('', 'password123')
    expect(container.querySelector('.login-error')?.textContent).toBe('起个名字吧')
    expect(calledWith('/api/login')).toHaveLength(0)

    await fillAndSubmit('   ', 'password123')
    expect(container.querySelector('.login-error')?.textContent).toBe('起个名字吧')
    expect(calledWith('/api/login')).toHaveLength(0)
  })

  it('⚠️ 登录成了、紧接着那一次 /api/me 失败 → 按钮不能还是「稍等…」', async () => {
    // 这条钉的是一个**死胡同**，不是"体验差"：onDone() 只是让 App 去问一次
    // /api/me，那一次失败也返回 null，于是 App 又渲染回登录页 —— 而 React 在
    // 同一个位置**复用组件 state**，登录页里那个 busy 还是 true。
    // 用户看到的是一个永远转下去的「稍等…」，唯一的出路是刷新页面。
    //
    // 项目规矩：凡是说"不行"的地方都要同时说"那怎么办"。一个永远转的按钮
    // 连"不行"都没说 —— 用户不知道要不要等，比报错更糟。
    // 这一条不用把 `meUser` 置空：`meFails` 一开，/api/me **每一次**都回 401
    // （不管是开页那次还是跟随那次），置空那一行是冗余的。
    setMeFails(true)
    await renderApp()
    await fillAndSubmit('小明', 'password123')

    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(false)          // 不能卡在"忙"上
    expect(submit.textContent).toContain('登录')   // 而且要重新说清这一步是干什么的
    // 用户打过的字也得还在：让他从头再打一遍密码，是最气人的一种失败
    // （顺带它还是"组件没被重新挂载"的探针 —— 重新挂载的话 state 会清空）
    // ⚠️ 两格**各看一次**，而且按字段名看：原来只看 `[0]` 那一格，也就是**只看
    //    名字**。密码在不在没人管，而"密码被清空"恰恰是这里最气人的那一种。
    expect(field('username').value).toBe('小明')
    expect(field('password').value).toBe('password123')
  })

  it('★ 跟随请求还在半路时按钮必须还是「稍等…」—— 不许留一个"再点一次"的窗口', async () => {
    // 反过来的那个坑：登录成功、`onDone()` 也调了，但 App 问「我是谁」那一次
    // **还没回来**。这时候就把按钮放开的话，用户看到的是
    // 「点完按钮又从『稍等…』变回『登录』，画面什么都没发生」—— 这正是最容易
    // 诱发"再点一下"的形状（再点一下就是第二次注册/登录请求）。
    // 窗口长度 = **一次 /api/me 往返**：本机几毫秒，但真机走移动网是几十到
    // 几百毫秒、差网能到秒级 —— 所以它得被「稍等…」盖住，而不是"反正很快"。
    setMeUser(null)
    await renderApp()

    // 登录那一次照常成功；`onDone` 之后那一次 /api/me 挂住不回
    const gate = makeGate()
    setMeGate(gate)
    await fillAndSubmit('小明', 'password123')

    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)            // ← 窗口必须在
    expect(submit.textContent).toContain('稍等')

    // 放行：App 这才认出人，进主界面
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    expect(container.querySelector('.login-box')).toBeNull()
  })

  it('★ 登录请求还在半路时，两颗按钮都得是禁用的（切换那颗也不许半路换模式）', async () => {
    // ★ 上一轮探针实测出来的形状（四条断言全中）：忙的时候点那颗切换按钮，
    //   **标题当场翻成「注册」**，而在飞的仍是一条**登录**请求 —— 它要是失败，
    //   服务端那句关于**登录**的话（「没有这个账号，去注册一个吧」）会落在
    //   「注册」标题底下。用户读到一句**归错地方**的话，照着它一步也走不下去。
    //
    //   为什么这轮才看得见：副标题上一轮删了、提交按钮忙的时候只肯说「稍等…」，
    //   于是忙的这几秒里**标题是屏上唯一还在说模式的字**（上面那条「标题就说这一步
    //   是干什么的」守的就是它）。标题以前写死「随心」、不参与模式，切换过去也
    //   看不出来 —— 这个错位一直躲在"看不出来"里。
    //
    //   `submit` 开头那句 `if (busy) return` 是**同一件事的半边**，它挡的是
    //   "用户等不及连点两下、交出去两条"；这一条守的是**另外半边**。
    //
    // ★ 变异（这一轮跑过）：把 `disabled={busy}` 从 `.login-switch` 上删掉 →
    //   红在 `expect(sw.disabled).toBe(true)`（`expected false to be true`）。
    setMeUser(null)
    await renderApp()

    // 把**登录那一次请求**挂住不回。⚠️ 特意不用上面那条的 `meGate`：那条挂的是
    // 跟进的 `/api/me`，而这里要的形状是"用户点切换的那一瞬间，在飞的是登录请求
    // **本身**"—— 只有这个形状才演得到"它失败时那句话落在错误的标题底下"。
    const gate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/login') await gate.promise
      return inner(url, init)
    })

    await fillAndSubmit('小明', 'password123')

    // 前提之一：确实"忙着"（提交按钮的口径 —— 它和切换按钮读的是同一个 `busy`）
    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toContain('稍等')
    // 前提之二：那条登录请求**真的在飞**。少了这一句，"忙"可以是本地校验卡住的假象，
    // 而这条用例讲的正是"在飞的那条和屏上说的模式对不上"。
    expect(calledWith('/api/login')).toHaveLength(1)

    // ★ 这一条的主角：提交按钮挡了、切换按钮没挡，等于没挡 —— 两处是同一个判断
    //   的落地，得一挡全挡。
    const sw = container.querySelector('.login-switch') as HTMLButtonElement
    // 少了这颗按钮要红成"少了这颗按钮"，不是 `Cannot read properties of null`
    expect(sw).toBeTruthy()
    expect(sw.disabled).toBe(true)

    // ★ 而且**点它模式不变** —— 这才是用户看得见的那一句。
    //   （jsdom 照 HTML 规范实现：点一颗禁用的表单控件等于没点。）
    await act(async () => {
      sw.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.login-title')?.textContent).toBe('登录')
    // 提交按钮也还在等它那条请求：忙的这几秒它一个字都不说模式（见上面标题那段），
    // 所以此刻屏幕上还在说"这一步是登录"的只有标题 —— 这正是不能让它翻面的理由。
    expect((container.querySelector('.login-submit') as HTMLButtonElement).textContent).toContain('稍等')

    // 放行：让在飞的那条走完（不在用例末尾留一个挂着的 promise），
    // 顺便确认"挡住切换"没有把正常这条路一起挡坏。
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.login-box')).toBeNull()
  })

  it('★ 用着用着票失效了（/api/route 回 401）→ 回到登录页，而不是一句提示', async () => {
    // ⚠️ 这条钉的是一个**死胡同**，落在 Task 6 和 Task 7 的**缝**里：
    // Task 6 的审查问"三个 AI 接口挡没挡住没登录的人"，Task 7 的审查问"登录页
    // 本身对不对"，**没有人问"401 到了前端之后会发生什么"**。
    // 而这一段界面上没有"退出"按钮、也没有用户管理页 —— 401 没人处理的话，
    // 用户看到的只是聊天里一句「先登录一下」，屏幕上没有任何回到登录页的路，
    // **唯一的出路是刷新页面**。和 2d333bb 修掉的是同一个形状。
    //
    // 这里**特意走真的 postRoute**（这个文件平时把它整个假掉）：让 /api/route
    // 真回一个 401，把 "401 → ApiError(UNAUTHORIZED) → App 认出来" 整条链走完。
    // 直接拿一个 ApiError 去 reject 会漏掉前半截 —— 而前半截正是"后端回的
    // code 到底是不是 UNAUTHORIZED"，链子断在那儿，App 这边再对也没用。
    const real = await vi.importActual<typeof import('./api/client')>('./api/client')
    vi.mocked(api.postRoute).mockImplementation(real.postRoute)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/route'
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    const before = canvasProps.images.at(-1)   // 已经打开的那张照片
    await say('亮一点')

    // 回到登录页：登录框在，修图那套（连选照片的入口）整个不在了
    expect(container.querySelector('.login-box')).toBeTruthy()
    expect(container.querySelector('input[type="file"]')).toBeNull()

    // ★ 而且**再登录回来之后，那张照片还在**。
    //   这就是"置空 user 而不是整页重载"要的副作用：App 没有卸载，修图状态
    //   原样留着。少了这一条，"回登录页"可以用 `location.reload()` 蒙过去 ——
    //   用户回来面对的是一张白纸，刚才那张照片得重新选。
    await fillAndSubmit('小明', 'password123')
    // 回来了，而且**一样都没丢**：登录页没了、照片还在画布上、刚才那句话还在
    // （注意这里不能拿 `input[type=file]` 当"回来了"的判据 —— 那是**没照片**时
    //  才有的上传入口，而这一趟照片一直都在。）
    expect(container.querySelector('.login-box')).toBeNull()
    expect(canvasProps.images.at(-1)).toBe(before)
    expect(container.textContent).toContain('亮一点')
  })

  it('★ 票失效的**另一条**路（/api/edit 回 401）也得回登录页 —— 两处 catch 各要有人咬', async () => {
    // 上面那条走的是 send → /api/route；这一条走的是生成那一段 → /api/edit。
    // "回登录页"在两处 catch 里各写了一遍（send / runGenerate），**只修一处照样
    // 是一条死胡同** —— 所以两处各要有一条测试咬住。只测其中一处的话，另一处
    // 删掉之后全仓照样绿，那条缝就还开着。
    const real = await vi.importActual<typeof import('./api/client')>('./api/client')
    vi.mocked(api.postEdit).mockImplementation(real.postEdit)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/edit'
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
        : inner(url, init))
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(container.querySelector('.login-box')).toBeTruthy()
    expect(container.querySelector('form.chat-input')).toBeNull()   // 修图界面整个让位
  })

  it('⚠️ 从登录切到注册 → 框里那几个字不能跟着过去', async () => {
    // 用户在用的时候发现的：「如果没有账号，切到注册页面不应该自动填充用户在
    // 登录页填充的信息」。查下去发现这不是"有人想过、权衡后留下的设计"，是
    // **没人想过** —— 那个切换按钮原来只做 setMode + setError(null)，三个输入
    // state 一个字都没动，注释里也只解释了为什么清 error。而它**一条测试都没有**，
    // 所以一直没人看见。
    //
    // 代价最难看清的是密码那一格：登录页上它问的是"我的密码"，注册页上它问的是
    // "给我设的新密码"，于是用户在登录页手滑打错的一个字符，会在他毫不知情的
    // 情况下变成新账号的密码。
    setMeUser(null)
    await renderApp()

    // 登录模式下只有两个框：名字、密码（邮箱那一格在注册模式下才渲染）
    // 数**几个**仍然是位置无关的判据（"登录页不给邮箱格"就靠它），所以留着；
    // 但**填哪一格**一律按字段名走，不按第几个。
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)
    const beforeName = field('username')
    const beforePass = field('password')
    await act(async () => {
      type(beforeName, '小明')
      type(beforePass, 'password123')
    })
    // ★ 前提：字**真的**打进去了。少了这两行，下面"三个框都是空的"是白捡的 ——
    //   `type` 哪天失灵（React 换了 tracker 的挂法之类），这条测试照样绿。
    expect(beforeName.value).toBe('小明')
    expect(beforePass.value).toBe('password123')

    const sw = container.querySelector('.login-switch') as HTMLButtonElement
    expect(sw).toBeTruthy()
    await act(async () => {
      sw.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // 模式真的换了：提交按钮上的字从「登录」改成了「注册」。
    // **按类名定位、只看文案** —— 按文案找元素的话，这条会退化成
    // "我按那句话找到了那个按钮"，而不是"用户看到的字变了没有"。
    //
    // ⚠️ 这里**原来还看一个 `.login-sub`（副标题）**：登录模式说"登录一下，你的图
    //    都在这儿"、注册模式说"注册一个，图就留下来了"。2026-09-25 用户看过页面
    //    之后说那一行不要了，元素整个不再渲染 —— 于是信号换成**提交按钮的文案**
    //    （`登录` / `注册`，见 LoginPage 里那行 `busy ? '稍等…' : …`）。
    //    它同样稳：不忙的时候这两种模式就这两个词，而这条用例从头到尾不碰 busy。
    //    **换的只是信号，守的东西没换** —— 下面这几句仍然要能被"点了切换却不改
    //    mode"咬住（这一轮的变异跑过：把 `setMode(...)` 摘掉，这条立刻红）。
    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit).toBeTruthy()
    expect(submit.textContent).toContain('注册')

    // 三个框全空：现在是名字、密码、邮箱（**逐格按字段名看**，不按"第几个"）
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    expect(field('email').value).toBe('')

    // ── 反向那半圈：注册 → 登录 → 注册 ────────────────────────────────
    // 上面那半圈**碰不到邮箱那一格**（它在登录模式下根本不渲染），所以它是
    // 「登录页填的东西跟过去」这一半；邮箱那一格只有这半圈守得住 ——
    // 实测：单独删掉 `setEmail('')` 那一行，上面的断言全绿。
    // 先在注册页把三个框都填上，再往回切两次，看它们有没有原地复活。
    const switchOnce = async () => {
      const btn = container.querySelector('.login-switch') as HTMLButtonElement
      expect(btn).toBeTruthy()
      await act(async () => {
        btn.click()
        await new Promise(r => setTimeout(r, 0))
      })
    }
    /** 一次把三格都填上。**按字段名填** —— 原来传的是 `['阿花', 'a@b.com',
     *  'password123']` 再按 `i` 取第几格，顺序一换成「名字/密码/邮箱」，
     *  这个数组就把邮箱打进了密码格（而测试照样绿）。 */
    const fillAll = async (username: string, password: string, email: string) => {
      await act(async () => {
        type(field('username'), username)
        type(field('password'), password)
        type(field('email'), email)
      })
    }

    await fillAll('阿花', 'password123', 'a@b.com')
    await switchOnce()                        // 注册 → 登录
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)
    // ★ 这一步的断言不是装饰：少了它，一个**只往一个方向清**的写法能溜过去 ——
    //   比如 `if (mode === 'login') { 清空 }`：登录 → 注册那半圈照清（上面全绿），
    //   反向不清（这里不查的话也绿），而最后那一步又清了一遍（还是绿）。
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    await switchOnce()                        // 登录 → 再注册
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    expect(field('email').value).toBe('')
  })

  it('★ 标题就说这一步是干什么的：登录页「登录」、注册页「注册」（用户拍板）', async () => {
    // 用户 2026-09-25 的原话：「登录页显示登录，注册页显示注册」。
    // 这里原来写死的是「随心」—— 那个中文名是**写账号那一段的计划时自己起的**，
    // 设计文档里从来没有过（文档里一直只叫 `RuiXing`）。他看到成品之后问
    // 「这个随心是啥？」，查出来的就是这个来历，于是拍了这一条。
    //
    // ⚠️ 这条守的不只是"两个词长什么样"，还有**它得跟着 `mode` 走**：
    //    副标题上一轮被删了（见 `LoginPage.tsx` 标题下面那段），所以这一屏上
    //    **仅剩的**那个一定会说话的模式标记就是这个标题 —— 另一个是提交按钮，
    //    而它 `busy` 的时候会变成「稍等…」（那几秒它不说模式，只有标题还在说）。
    //
    // ⚠️ 所以两个模式**各断一次**，而且走用户点的那颗按钮切 —— 只断登录那一半的话，
    //    写死成 `'登录'` 照样绿（"看着在守、其实守不住"那个形状，本仓库栽过）。
    //
    // ★ 变异（这一轮跑过）：写死成 `'登录'` → **红在第二句**；
    //   写死回 `'随心'` → 两句都红（`expected '随心' to be '登录'`）。
    setMeUser(null)
    await renderApp()

    const title = () => container.querySelector('.login-title')?.textContent
    // 少了那颗标题要红成"少了标题"，不是 `expected undefined to be '登录'`
    expect(container.querySelector('.login-title')).toBeTruthy()
    expect(title()).toBe('登录')

    // 切过去（走 `.login-switch` 那颗真按钮，不是直接改 state）
    await switchToSignup()
    expect(title()).toBe('注册')
  })

  it('★ 点一下那个开关，密码就看得见了；再点一下，又变回圆点', async () => {
    // 用户报的原话：「我输的密码是admin123，是已经有这个账户了吗？还是提示信息不对？
    // **密码输入框加入一个可视化**」—— 打进去全是圆点，他没有任何办法确认自己打对没有。
    setMeUser(null)
    await renderApp()

    const pass = passwordBox()
    expect(pass).toBeTruthy()

    expect(pass?.getAttribute('type')).toBe('password')   // 起点：圆点

    // 先在框里打一笔字 —— 下面"看得见"那半件事要断言的是**同一格、同一笔字**。
    // 从一个空框开始的话，`value` 那两句是白捡的（空框永远等于空框）。
    await act(async () => { if (pass) type(pass, 'admin123') })
    expect(pass?.value).toBe('admin123')

    await toggleEye()
    // ★ 变异 A：把 `type={showPassword ? 'text' : 'password'}` 换回写死的
    //   `type="password"` → **红在这一句**（`expected 'password' to be 'text'`）。
    expect(pass?.getAttribute('type')).toBe('text')
    // 而且是**同一格、字没丢**：谁要是"另外找个元素去显示明文"，用户刚打的密码就没了。
    expect(pass?.value).toBe('admin123')
    // 那颗眼睛的"名字"也得跟着说反话 —— 停在「显示密码」的话，读屏的人听到的还是"显示"。
    // （2026-09-25 第二轮：按钮上那两个字**换成了图标**，所以这里断言的从
    //  `textContent` 改成了 `aria-label` —— 图是猜的，文字才是说得清的。）
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('隐藏密码')

    await toggleEye()
    expect(pass?.getAttribute('type')).toBe('password')
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('显示密码')
  })

  it('★ 那颗眼睛的"名字"必须跟着状态走 —— 图标是猜的，文字才说得清', async () => {
    // 为什么这一条是硬要求：**哪张眼睛代表哪个状态，市场上没有共识** ——
    // 三个真实讨论的标题就是「我的眼睛按钮反了：该显示的时候变成了隐藏」、
    // 「Material Design 里密码切换图标是反的」、「两个状态下长得一样（bug）」。
    // 所以图标本身是**猜的**，说得清的是文字。而用户能拿到的文字只有两处：
    // `title`（鼠标停上去看得见）和 `aria-label`（读屏听到的）——
    // 两个都必须说**点下去会发生什么**，而且必须跟着状态走。
    //
    // ★ 变异①：把 aria-label / title 写死成一句话（不跟状态变）→ 这条红
    //   （露着的时候听到的还是"显示密码"，读屏的人会以为点下去是显示）。
    // ★ 变异②：把 title 删掉 → 红在 `expected null to be '显示密码'`
    //   （鼠标停上去什么也没有，用户只能靠猜图标）。
    setMeUser(null)
    await renderApp()

    const eye = () => container.querySelector('.login-eye')
    expect(eye()).toBeTruthy()                       // 少了这个控件要红成"少了控件"
    // 图标本体是**内联** SVG（零新依赖那条线上，这也顺带证明"眼睛真的画出来了"）。
    expect(eye()?.querySelector('svg')).toBeTruthy()
    // 默认藏在状态：说的是"点下去会让你看见"
    expect(eye()?.getAttribute('aria-label')).toBe('显示密码')
    expect(eye()?.getAttribute('title')).toBe('显示密码')

    await toggleEye()
    expect(passwordBox()?.getAttribute('type')).toBe('text')   // 前提：真的切到明文了
    expect(eye()?.getAttribute('aria-label')).toBe('隐藏密码')
    expect(eye()?.getAttribute('title')).toBe('隐藏密码')
    // 两个说法必须**一致**：一个说"显示"一个说"隐藏"的话，看的人和听的人
    // 得到的是两回事 —— 而那正是那个图标本身没法解决的歧义。
    expect(eye()?.getAttribute('title')).toBe(eye()?.getAttribute('aria-label'))
  })

  it('★★ 点那个开关**不会**把表单交上去 —— 它在 `<form>` 里，漏个 type 就是提交按钮', async () => {
    // 这一条是给那个按钮上的 `type="button"` 兜底的。它所在的
    // `<form className="login-box" onSubmit={submit}>` 是**真的表单**，
    // 而表单里一个不写 `type` 的 `<button>` **默认就是 `submit`**：
    // 用户想看一眼密码打对没有，点一下「显示」—— 填好的密码**当场被交上去**。
    // 这是这一件里最容易犯、也最贵的错，所以它得有一条自己的断言。
    //
    // ★ 两个框**先填成能过前端校验的样子**再点。留空的话，漏写 type 也只会走到
    //   「起个名字吧」那一句，**一个请求都不会发** —— 那样"没发请求"这条断言
    //   看着在守、其实守不住（不加前提的断言是白捡的，本仓库栽过这个形状）。
    setMeUser(null)
    await renderApp()

    const name = field('username')
    const pass = field('password')
    await act(async () => {
      type(name, '小明')
      type(pass, 'password123')
    })
    // 前提：字真的都进去了（名字不合法的话，下面那几条全是白捡的）
    expect(name.value).toBe('小明')
    expect(pass.value).toBe('password123')

    await toggleEye()

    // ★ 变异 B：把 `type="button"` 删掉 → **红在下面第一句**
    //   （`expected [ [ '/api/login', … ] ] to have a length of 0`）。
    expect(calledWith('/api/login')).toHaveLength(0)             // 一个请求都没发出去
    expect(container.querySelector('.login-box')).toBeTruthy()   // 还停在登录页：模式没变
    expect(container.querySelector('.login-submit')?.textContent).toContain('登录')
    expect(container.querySelector('.login-error')).toBeNull()   // 也没有多出一句提示
  })

  it('★ 切模式之后，开关回到「隐藏」—— 密码都清空了，还开着明文没道理', async () => {
    setMeUser(null)
    await renderApp()

    await toggleEye()
    expect(passwordBox()?.getAttribute('type')).toBe('text')   // 前提：它真的开着

    const sw = container.querySelector('.login-switch') as HTMLButtonElement | null
    expect(sw).toBeTruthy()
    await act(async () => {
      sw?.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // ★ 变异 C：把切换 handler 里那句 `setShowPassword(false)` 去掉 →
    //   **红在这一句**（模式切了、密码也清空了，但那一格还开着明文）。
    expect(passwordBox()?.getAttribute('type')).toBe('password')
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('显示密码')
  })

  it('★ 三个框的先后是「名字 → 密码 → 邮箱」（用户拍板），而且它们挂着自己的字段名', async () => {
    // 用户 2026-09-25 的原话：「这三个的顺序依次是账户和密码然后是邮箱」。
    // 道理是**必填的两个挨着，性质不同的那个放最后**（邮箱是留给"以后找回密码"
    // 的备件，见设计 §6.4）。
    //
    // ⚠️ 这一条不只是在钉一个审美决定 —— 它是**位置式取法**的唯一守卫。
    // 这个仓库里原来有十七处代码按"第几个框"去填这三格（这个文件里十处、
    // `.superpowers/` 下的验收探针七处），谁都没写字段名：顺序一换，它们
    // **照样是绿的**，只是全都在往错误的框里打字（对照实测过，见 `field()` 那段）。
    // 那些地方现在都改按 `name` 取了，而这一条负责在有人把顺序调回去时
    // **当场喊一声**，而不是让一屏绿着的测试继续骗人。
    //
    // ★ 变异①：把 LoginPage 里邮箱那一块挪回密码前面 → 红在第①句
    //   （`['username','email','password']` vs `['username','password','email']`）。
    // ★ 变异②：把三个 `name=` 属性删掉 → 红在第①句（`[null,null,null]`）。
    setMeUser(null)
    await renderApp()
    await switchToSignup()

    const inputs = [...container.querySelectorAll<HTMLInputElement>('.login-field input')]
    // 前提：注册模式下真的是三格（少一个的话下面两句比的是别的东西）
    expect(inputs).toHaveLength(3)

    // ① 每一格挂着自己的字段名 —— 这是那些代码现在取值的**钩子**，也是这一格的身份
    expect(inputs.map(i => i.getAttribute('name'))).toEqual(['username', 'password', 'email'])

    // ② 再拿**不依赖那个钩子**的东西钉一遍顺序：三格各自的 `type`。
    //    只钉 `name` 的话，把钩子挂错元素（比如 `name="password"` 挂到邮箱那格上）
    //    这一条照样绿 —— 而那正是最坏的一种错：钩子看着在、指向却是别人。
    //    名字格没有 type（就是默认的文本），密码是 password，邮箱是 email。
    //    ⚠️ 密码那格的 type 会跟着那颗小眼睛变，这里断言的是**默认**（圆点）那一档。
    expect(inputs.map(i => i.getAttribute('type') ?? 'text')).toEqual(['text', 'password', 'email'])
  })

  it('★ 星号只属于注册页：登录那两格不标「必填」，注册三格都标 —— 星号自己不会说话', async () => {
    // 用户 2026-09-25 的第 2 条：「账户和密码是必填的所以可以打上"*"」。**邮箱也是
    // 必填的** —— 他以为它选填，是因为它没标星号
    // （设计 §6.4：邮箱是找回密码的唯一通道，而找回密码排在第三段）。
    //
    // ⚠️ 2026-09-26 用户又拍了第 3 条（原话）：「登录页的密码和账户不用加"*"」。
    //    道理是"必填"在登录页上是**废话** —— 不填根本登不进去；那个记号本来就是
    //    **注册表单**的约定（注册时你可能有得选）。所以这一条从"三格都标"改成
    //    **按模式分**：登录页那两格都没有，注册页三格都有 —— **两个方向都得红**，
    //    证明它守的是"按模式分"而不是"反正有没有"。
    //
    // ⚠️ 他当时还要了另半件：「找个地方解释"*"是必填」。上一轮落地的是一句**屏上
    //    看得见**的 `.login-hint`「打 * 的都得填」。**2026-09-25 他又看过页面，
    //    说那一句不要了** —— 元素删除，钉着它的那段断言**跟着删掉**（不是改松：
    //    它守的东西已经不存在了）。所以现在这句话**屏上那一半没有了**，
    //    只剩下面这一条：可访问性树里那份「（必填）」—— 而它现在也**只管注册页**。
    //
    // ⚠️ 光加一个裸的 `<span>*</span>` **不算做完**：读屏软件念一个孤零零的星号，
    //    听的人既不知道它什么意思，也不知道它在修饰哪一格。所以每一格的标签里
    //    都配了一份**只在可访问性树里在**的字（`Req` 里那份 `.login-sr` 的
    //    「（必填）」），于是那一格的可读名字是「名字（必填）」。
    //    而星号自己挂 `aria-hidden`：不然会听到"名字 星号 （必填）"，
    //    那个音节没有任何意义。
    //
    // ⚠️ 另外**故意没有**加 HTML 的 `required`：它会让浏览器用**自己语言**的
    //    气泡抢先弹出来，把本仓库那几句自己写的中文提示挤掉（`checkUsername` /
    //    `checkEmail` / `checkPassword`）。最后一句钉着"没人把它加回来"。
    //
    // ★ 变异 A（这一轮跑过）：把 `<Req />` 加回**登录模式**的名字或密码那一格 →
    //   红在第 ① 段（"登录页 xxx 那格不该有星号"，或紧跟着那句"读屏不该听到必填"）。
    // ★ 变异 B（这一轮跑过）：把**注册模式**那三格里的 `<Req />` 去掉 →
    //   红在第 ② 段（`username 那一格读不出"必填"`）。
    // ★ 变异③：把某一格 `.login-star` 里的 `*` 去掉（但 `.login-sr` 留着）→
    //   红在下面那句 `expect(m.name).toContain('*')`（`star?.textContent` 也红）。
    // ★ 变异④：只留裸 `<span>*</span>`（把 `.login-sr` 那半截删掉）→ 红在
    //   「标签里有读得出的'必填'」。
    // ★ 变异⑤：把 `.login-sr` 换成 `display: none`（jsdom 里查不出来）——
    //   这一条**拦不住**，只有 styles.css 里那段注释知道。写在这儿免得下一个人
    //   以为这条测试把它也守住了。
    //
    // ⚠️ 原来这里还列着一条变异「删掉 `<p className="login-hint">` 那一行 → 红在
    //    屏上那句解释」。那句被用户删了，元素和那条变异一起走。
    setMeUser(null)
    await renderApp()

    // ⚠️ 这里原来是 ①：钉着屏上那句解释（`.login-hint`）的**字和位置**，以及
    //    "它必须真的看得见"（不能借 `.login-sr` 那套藏起来）。那句被用户删了，
    //    元素和那段断言一起走 —— `LoginPage.tsx` 标题下面记着这件事的代价。

    /** 读屏软件听到的那一格名字 = 它的 `<label>` 的文字。
     *  名字/邮箱那两格的 label 是**包着** input 的，密码那格是 `htmlFor` 配对的 ——
     *  两种都得认（只认前一种的话，密码那格会静默地被跳过）。 */
    const readableName = (el: HTMLInputElement) => {
      const wrap = el.closest('label')
      if (wrap) return wrap.textContent ?? ''
      return container.querySelector(`label[for="${el.id}"]`)?.textContent ?? ''
    }
    /** 一格此刻"必填"那套记号：星号在不在、读屏听不听得见、有没有原生 `required`。
     *  三样一起看，因为它们**各自会被一种改法漏掉**：只钉星号的话，星号还在而
     *  `.login-sr` 被顺手删掉（或换成 `display: none`）照样绿，而"听不听得见"
     *  恰恰是用户要的那半；只钉可读名字的话，星号被摘掉也照样绿。 */
    const reqMarks = (el: HTMLInputElement) => ({
      star: el.closest('.login-field')?.querySelector('.login-star') ?? null,
      name: readableName(el),
      native: el.hasAttribute('required'),
    })

    // ① **登录页**（打开产品就是这一屏）：名字、密码两格**都不标**"必填"。
    //    ★ 变异 A 红在这里。
    for (const which of ['username', 'password'] as const) {
      const m = reqMarks(field(which))
      expect(m.star, `登录页 ${which} 那格不该有星号`).toBeNull()
      expect(m.name, `登录页 ${which} 那格读屏不该听到"必填"`).not.toContain('必填')
      expect(m.name).not.toContain('*')
      expect(m.native).toBe(false)
    }
    // 前提：登录页真的只有那两格。少这句的话，将来谁把邮箱那一格漏在登录模式下，
    // 上面那个循环还是绿的（它只遍历两格）—— 而"登录页问的只有我是谁"是另一条
    // 测试在管的事，这里只说"这一段比的是那两格"。
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)

    // ② **注册页**：三格都标（用户 2026-09-25 要的那一条，原样保留）。
    //    ★ 变异 B 红在这里。
    await switchToSignup()
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    for (const which of ['username', 'password', 'email'] as const) {
      const el = field(which)
      const m = reqMarks(el)
      expect(m.name, `${which} 那一格读不出"必填"`).toContain('必填')
      expect(m.name).toContain('*')          // 星号也在同一格里
      expect(m.star?.textContent).toBe('*')
      expect(m.star?.getAttribute('aria-hidden')).toBe('true')
      // ★ 而且**不要**原生 `required`（原因见上面那段注释）。
      expect(m.native).toBe(false)
    }
  })
})

describe('用户管理页', () => {
  /** 左栏那颗「个人设置」。
   *
   *  ⚠️ **2026-10-04 起按 `aria-label` 找，不是按文字** —— 用户说
   *  「个人设置改为人物图标」，那颗按钮现在里面只有一个人物图标，
   *  `textContent` 是**空字符串**。名字搬进了 `aria-label`（还有 `title`）。
   *  按文字找的那一版不会报错，只会"找不到那颗按钮" —— 而那种红很容易被
   *  当成"页面坏了"，其实是标签换了个地方放。 */
  function accountNav(): HTMLButtonElement | null {
    return [...container.querySelectorAll('.nav button')]
      .find(b => b.getAttribute('aria-label') === '个人设置') as HTMLButtonElement | null
  }

  /** 从左栏那颗「个人设置」进去 —— 用户真会走的那一条路。 */
  async function openAccount() {
    const btn = accountNav()
    expect(btn).toBeTruthy()
    await act(async () => {
      btn?.click()
      // 这一页挂载时会自己去拉一次作品列表（使用情况）。**两个滴答**：
      // 第一个让点击引起的渲染落定，第二个让那次请求的 `.then` 也落定 ——
      // 只放一个的话，下面「显示的是真数」那几条看到的是"还在路上"的占位。
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  /** 使用情况那一格现在写的是什么（`.account-stats` 整格不在时回 null）。 */
  function statsText(): string | null {
    return container.querySelector('.account-stats')?.textContent ?? null
  }

  /** 按**行上那几个字**取一行（现在有三行：模型 / 改密码 / 注销账号）。 */
  function rowByLabel(label: string): HTMLButtonElement {
    const row = [...container.querySelectorAll('.account-row')]
      .find(r => r.querySelector('.account-row-label')?.textContent === label)
    expect(row, `没有「${label}」那一行`).toBeTruthy()
    return row as HTMLButtonElement
  }

  /** 往受控输入框里打字（和「登录这道门」里那个同一个做法）。 */
  function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('★ /app/account 打得开，而且不是白屏', async () => {
    // 这一条走**网址**（不是点按钮）：地址栏是可以被直接打开的 —— F5、收藏夹、
    // 别人发来的一条链接。`viewFromPath` 少认一行，打开这里的人拿到的就是
    // 落地页或修图页，而不是他点开的那一页；而白屏是最差的那种答案。
    history.replaceState(null, '', '/app/account')
    await renderApp()

    expect(container.querySelector('.account')).toBeTruthy()
    // 用户名是这一页的主句（§3.6 那张图最上面那一行）—— 它在，这一页就没白
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
    // ★ 2026-10-04：**那三个字也得在**（用户看完这一页说「用户名没显示出来」）。
    //   他的测试账号正好叫「111」—— 屏幕上只有一个孤零零的数字时，读不出
    //   "这是你的用户名"。标签是**另起一格**，`.account-name` 里仍然只有名字
    //   （上面那条断言就是钉这个的）。
    expect(container.querySelector('.account-label')?.textContent).toBe('用户名')
  })

  it('★ 右上角那颗 👤 点得开它，而且地址栏跟着走', async () => {
    // 顶栏那两颗按钮（分享 / 保存）只在**有照片**的时候才在，而 👤 无论如何都在：
    // 用户第一次进来、还没选图的时候也该找得到自己那一页。
    await renderApp()
    expect(container.querySelector('.welcome')).toBeTruthy()   // 起点：还没选图的修图页
    await openAccount()

    expect(container.querySelector('.account')).toBeTruthy()
    // 地址栏也得跟着走 —— 这一页可以直接发链接、也可以 F5（`pathOf` 少一行就断）
    expect(location.pathname).toBe('/app/account')
  })

  it('★ 页面上不许出现我们自己用的模型名或接口地址（§7.3 + §10 的变异测试）', async () => {
    // 变异：把 `sensenova-6.8-flash-lite` / `token.sensenova.cn` 写死进这一页
    // → 这一条必须红。用户看到的只该是「默认」和别名 —— 型号名对他没意义，
    // 限制才有意义（§7.3）。
    await renderApp()
    await openAccount()
    // ★ 前提：这一页**真的开着**。少了这一句，下面两条 `not.toContain` 会因为
    //   "整页什么都没渲染"而白白通过 —— 否定断言最典型的假绿。（本文件在
    //   `.save-fail` 那两条上踩过同一个坑，那边是靠"只扫横幅那一段"解决的。）
    expect(container.querySelector('.account')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('sensenova')
    expect(document.body.textContent ?? '').not.toContain('token.sensenova.cn')
  })

  it('★ 点「退出登录」→ 真的退出去了', async () => {
    await renderApp()
    await openAccount()

    const out = container.querySelector('.account-signout') as HTMLButtonElement | null
    expect(out?.textContent).toBe('退出登录')
    expect(out?.disabled).toBe(false)          // 按钮得真的能按
    await act(async () => {
      out?.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 服务端**真的被通知了**：会话在 cookie 里，前端清不掉它 ——
    //    只把人放走、不告诉后端，下次刷新他又"登着"回来了。
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/logout' && c[1]?.method === 'POST'))
      .toBe(true)
    // ② 人已经不在这一页上了。回到登录页 —— App 里每一处"票不管用了"都回那儿
    //    （见 isUnauthorized 那段注释），"退出登录"是同一件事的用户主动版。
    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('★ 退出的请求失败也要放人走 —— 不能因为网络不好就把人困在页面上', async () => {
    // 服务端那条路是幂等的、只清一个 cookie（连请求体都不读），而用户要的是"离开"。
    // 困住他的形状是：点了退出、屏幕上什么都没变 —— 他只会以为自己没点着，
    // 然后再点一次、再点一次。
    // 变异：把 AccountPage 里那个 `.catch(() => {})` 删掉 → 这一条红
    //      （`.then(onSignedOut)` 挂在一条已经 reject 的链上，永远不会执行）。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/logout'
        ? jsonResponse({ error: { code: 'INTERNAL', message: '没清干净' } }, 500)
        : inner(url, init))

    await renderApp()
    await openAccount()
    const out = container.querySelector('.account-signout') as HTMLButtonElement
    await act(async () => {
      out.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('★ 使用情况显示的是**真数** —— 不是写死的 0', async () => {
    // 第一版是 App 传死 `workCount={0}`：这一页对**每个**存过作品的人都说
    // 「0 张作品」。
    // ★ 2026-10-04：数据源从"前端拉整份作品清单自己加"换成了 `/api/me` 的
    //   `usage` —— 那边把**会话**占的空间也算进去了（会话里的原图和每一步的底
    //   也是用户的文件），前端那份只看得见作品。
    // 变异：把那一格改回写死 `0` → 这一条红。
    const MIB = 1024 * 1024
    withUsage({ count: 2, bytes: 10 * MIB })
    await renderApp()
    await openAccount()

    expect(statsText()).toMatch(/^2\s*张作品/)
    expect(container.querySelectorAll('.stat')).toHaveLength(1)
    // ★ 2026-10-05：两个数**画在图形里**（用户：「没有总用量和实际用量呀」→
    // 加了图例 → 「也要在图形中展现出来」→ 搬进图形区域 → 「我觉得应该显示
    // 剩余用量吧？」→ 「总共」换成「剩余」）。体积是服务端算的，上限 5 GiB。
    expect(container.querySelector('.usage-chart-used')?.textContent).toContain('已用 10 MB')
    // 5 GiB − 10 MB = 4.99 GiB → formatSize 一位小数 → 「5.0 GB」
    expect(container.querySelector('.usage-chart-rest')?.textContent).toContain('剩余 5.0 GB')
    expect(container.querySelectorAll('.usage-chart-dot')).toHaveLength(2)
    // 10 MB / 5 GB = 0.2% —— 远没到 80%，那条提醒不该出现
    expect(container.querySelector('.account-quota-warn')).toBeNull()
  })

  it('★ 用量饼图画的是**真比例** —— 0.2% 也配拥有它的一个小角（2026-10-05）', async () => {
    // 用户原话四连：「磁盘用量可视化一下用圆盘表示」→「立体的大一点的圆盘图表」
    // →「我想到了就是磁盘用量是一个叫做饼图的」→（发了张 Excel 3D 饼图）
    // 「第二个图是我想要设计的样子」。最后定型成 **3D 厚饼**：顶面椭圆 + 侧壁。
    // 钉两样：饼下的百分比文字、和已用扇形顶面的 `d`（几何全部由 pie3dPaths
    // 这个纯函数采样出来 —— 特征坐标的钉子在下一条用例里）。
    const MIB = 1024 * 1024
    const LIMIT = 5 * 1024 ** 3
    withUsage({ count: 2, bytes: 10 * MIB })     // 10 MB / 5 GiB ≈ 0.195%
    await renderApp()
    await openAccount()

    // ★ 第八/九/十轮：这行原来裸着 → 补主语 → 翻成**剩余**视角 → 「剩余」和数字
    // 并成同一个款式（用户：「字体和颜色应该跟数字保持一致吧」）。
    // 10 MB / 5 GiB = 0.2% 已用 → 剩余 99.8%。变异：把「剩余」两个字删掉 → 这一条红
    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 99.8%')
    // 扇形画的是"真比例套一道**可见性下限**"（2026-10-05 第七轮：0.195% 只有一根
    // 看不见的针，用户连说三轮"图上没有已用"→ 小于 5° 的按 5° 画；数字全是真的。
    // ⚠️ 别再加末端圆点/珠子 —— 第七轮加过，用户否了：「大圆圈也不好看呀」）。
    const drawRatio = Math.max((10 * MIB) / LIMIT, MIN_SLICE_RATIO)
    const d = container.querySelector('.usage-pie-used-top')?.getAttribute('d') ?? ''
    expect(d).toBe(pie3dPaths(drawRatio).usedTop)
    // 剩余那半块（蓝）也在 —— 0.2% 时它才是画面主体
    expect(container.querySelector('.usage-pie-rest-top')).toBeTruthy()
    // 远没到八成：饼不带警告类（饼和数字"一起变红"那条规矩的另一半）
    expect(container.querySelector('.usage-pie-warn')).toBeNull()
    // 变异：把比例写成写死的数（或 0）→ 前两条红
  })

  it('pie3dPaths：三档几何（0 / 五分之一 / 满）（2026-10-05）', () => {
    // 采样出来的点串很长，钉**特征点**（坐标手算）+ 侧壁的有/无。
    // 椭圆参数：圆心 (60,52)、rx 48、ry 28、厚度 16；12 点起笔顺时针。
    const p0 = pie3dPaths(0)
    expect(p0.usedTop).toBeNull()                 // 一点没用 → 没有扇形
    expect(p0.usedSide).toBeNull()
    expect(p0.restTop).toContain('L60.00 24.00')  // 整块厚饼从 12 点（52−28）起画
    expect(p0.restSide).toBeTruthy()              // 一整圈下半沿都有厚度

    const p20 = pie3dPaths(0.2)
    // 五分之一：弧扫 72°，终点在 −18° → x = 60+48·cos18° = 105.65、y = 52−28·sin18° = 43.35
    expect(p20.usedTop).toContain('L105.65 43.35')
    // 这段弧全在椭圆**前半**（y ≤ 圆心）→ 侧壁被顶面自己挡住，不画
    expect(p20.usedSide).toBeNull()

    const p75 = pie3dPaths(0.75)
    expect(p75.usedSide).toBeTruthy()             // 扫过下半沿（6 点方向）→ 有厚度

    const p1 = pie3dPaths(1)
    expect(p1.restTop).toBeNull()                 // 全满 → 没有剩余
    expect(p1.restSide).toBeNull()
    // 变异：把 ry 写成 0（拍成一条线）/ 把侧壁的"下半沿"条件写反 → 上面某条红
  })

  it('★ 剩余率不许显示成「100%」（那是句假话）—— 显示「>99.9%」', async () => {
    // 495 KB / 5 GiB ≈ 0.0094% 已用 → 剩余 99.9906%。四舍五入到一位小数就是
    // "100.0%"——读起来是"一个字节都没存"。用户在真机截图里抓到过它的**镜像**
    //（已用口径的「0.0%」）—— 同一条罪（《文案规范》：先问"这句话在什么情况下
    // 是假的？"）。第九轮口径翻成"剩余"之后，这颗钉子跟着镜像成「>99.9%」。
    withUsage({ count: 1, bytes: 495 * 1024 })
    await renderApp()
    await openAccount()

    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 >99.9%')
    // 变异：把 `>99.95` 那一档删掉（退回 toFixed(1)）→ 显示「剩余 100.0%」，这一条红
  })

  it('★ 服务端没给用量时**那一格整个不出现** —— 不硬凑 0，也不硬凑体积', async () => {
    // 「别硬凑」的具体形状：拿不到就说不出真话，那就**少说一句**（§3.6）——
    // 「0 张作品」对着一个存过 128 张的人是一句假话，而这页一进去就能看见。
    // `meUsage = null` 就是"响应里没有 usage"的形状（老后端、或者半坏的响应）。
    setMeUsage(null)
    await renderApp()
    await openAccount()

    // 前提：这一页**真的开着**。少了它，下面"没有数字"会因为整页没渲染而假绿。
    expect(container.querySelector('.account')).toBeTruthy()
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
    expect(statsText()).toBeNull()
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)
  })

  it('★ 拿不到使用情况时**一个数字都不显示** —— 绝不退回 0', async () => {
    // ★★ 这一条就是审查说的那个 bug 的形状。审查原话：
    //   「任何有作品的人都会在自己的账号页看到『0 张作品』……这不是能力免责声明，
    //     而是关于用户数据的一句假话」（《文案规范》§3：写之前先问"这句话在
    //     什么情况下是假的？"）。
    // 变异：把「拿不到就整格不出现」改成画 0（= 第一版的行为）→ 这一条必须红。
    withUsageError('SENTINEL-数不出来')
    await renderApp()
    await openAccount()

    // 前提：这一页**真的开着**。少了它，下面"没有数字"会因为整页没渲染而假绿。
    expect(container.querySelector('.account')).toBeTruthy()
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
    expect(statsText()).toBeNull()
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)
  })

  it('★ 还没拉回来的时候显示占位「…」，也不是 0', async () => {
    // 「0」读起来是关于用户资产的一句**断言** —— 哪怕只闪半秒也不该是假的。
    // 变异：把占位换成写死的 `0` → 这一条红。
    const gate = makeGate()
    setMeUsageGate(gate)
    await renderApp()
    // 这里**不走 openAccount()** —— 它会把那两个滴答放过去，而这一条要的就是
    // "还在路上"的那一瞬间。
    const btn = accountNav() as HTMLButtonElement
    await act(async () => { btn.click() })

    expect(container.querySelector('.account')).toBeTruthy()
    expect(statsText()).toContain('…')
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)

    // 放行之后回的是"什么都没存" —— 那时候「0 张作品」就不是假话，而是事实。
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(statsText()).toMatch(/^0\s*张作品/)
  })

  /**
   * ★ 2026-10-04：用户管理页补的三件里的两件（§3.6 那张图上的 改密码／注销账号）
   * 和 §6.6 的 80% 提醒。这一页原来写着「注销账号**这一版不做**：
   * 它会连带删掉作品和文件，而"删了什么、能不能后悔"还没有定案」——
   * 现在定案了：**说清删什么、能不能后悔，再要一次确认**。
   */
  it('★ 空间用到 80% → 那一格变色 + 一句带出路的提醒（不能等满了才说）', async () => {
    // spec §6.6 原话：「等用户存不进去了才告诉他"满了"，是最糟的一种做法 ——
    // 他那一刻正想保存，你把他堵在门口。」
    // ⚠️ 张数按每张 2 MB 估（spec 自己写的「5 GB（约 2500 张）」），所以文案说"约"。
    const GB = 1024 ** 3
    withUsage({ count: 3, bytes: 4.2 * GB })   // 84%
    await renderApp()
    await openAccount()

    const warn = container.querySelector('.account-quota-warn')
    expect(warn?.textContent).toContain('还能存约')
    expect(warn?.textContent).toContain('八成')
    // 那一格"变色"的载体：饼变红、百分比红、**图里"已用"那行的数字**红（CSS 按
    // `.usage-pie-warn` 选择器上色；DOM 上钉 warn 类 + 两个元素都在）。
    expect(container.querySelector('.usage-pie-warn')).toBeTruthy()
    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 16%')   // 剩余视角：84% 已用 → 16% 剩余
    expect(container.querySelector('.usage-chart-used')?.textContent).toContain('4.2 GB')
    // 「剩余」不是摆设：84% 时它必须给出真正的余量（5 GiB − 4.2 GiB = 0.8 GiB = 819 MB）
    expect(container.querySelector('.usage-chart-rest')?.textContent).toContain('剩余 819 MB')

    // 出路是**一条真走得通的路**：点进去就是作品集（提醒不给出路 = 把人拉进没有门的房间）
    await act(async () => {
      (warn?.querySelector('.account-quota-go') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(location.pathname).toBe('/app/works')
  })

  it('★ 改密码：填完提交 → 真的打 /api/password，成功那句要说清"其他设备"', async () => {
    // §6.5：改密码 = **所有设备下线**（票的签名里掺着密码哈希），当前这台会被
    // 服务端发一张新票、不会掉。所以成功那句话必须提"其他设备"—— 不然用户
    // 在另一台机器上突然被登出，只会以为是自己点错了什么。
    await renderApp()
    await openAccount()

    await act(async () => { rowByLabel('改密码').click() })
    const form = container.querySelector('.account-form') as HTMLFormElement
    expect(form).toBeTruthy()

    await act(async () => {
      type(form.querySelector('input[name=oldPassword]') as HTMLInputElement, 'oldpassword1')
      type(form.querySelector('input[name=newPassword]') as HTMLInputElement, 'newpassword1')
    })
    await act(async () => {
      (form.querySelector('.account-submit') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    const call = fetchMock.mock.calls.find(c => c[0] === '/api/password')
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      oldPassword: 'oldpassword1', newPassword: 'newpassword1',
    })
    expect(container.querySelector('.account-msg')?.textContent).toContain('其他设备')
    // 密码框清空了（改完还留着一串密码在屏幕上，是"看着像没成功"的形状）
    expect((form.querySelector('input[name=oldPassword]') as HTMLInputElement).value).toBe('')
  })

  it('★ 注销：要**再确认一次**，那句话得说清删什么、能不能后悔', async () => {
    // 用户管理页原来那句「这一版不做」就是卡在这两件事上（见 AccountPage 的注释）。
    await renderApp()
    await openAccount()

    await act(async () => { rowByLabel('注销账号').click() })
    const danger = container.querySelector('.account-danger')
    expect(danger?.textContent).toContain('作品和照片会一起删掉')
    expect(danger?.textContent).toContain('删了就找不回来')
    // **还没按确认 —— 一个删除请求都没发**（点了会出事的按钮，不能只点一下就出事）
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false)

    // 「先不注销」把这一块收回去
    await act(async () => { (danger?.querySelector('.account-cancel') as HTMLButtonElement).click() })
    expect(container.querySelector('.account-danger')).toBeNull()

    // 再来一次，这回确认
    await act(async () => { rowByLabel('注销账号').click() })
    await act(async () => {
      (container.querySelector('.account-danger-submit') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/account' && c[1]?.method === 'DELETE'))
      .toBe(true)
    // 注销成功 = 人都不在了，和退出登录同一条出口：回登录页
    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('★ 有「模型」这一项，点了进模型设置（Task 8 挪过来的那一条）', async () => {
    // 从 Task 8 手里接过来的：那一轮这一页只立了骨架，「模型」这一行**故意**
    // 没挂（视图还不存在）。现在那一页立起来了，这一条跟着搬过来。
    withModels([
      MODEL(1, { alias: '我的便宜货', modelId: 'deepseek-chat', active: true }),
      MODEL(2, { alias: '那个快的' }),
    ])
    await renderApp()
    await openAccount()

    // ⚠️ 按**行上的字**找，别拿 `.account-row` 里的第一个 —— 2026-10-04 晚改版之后
    //    列表的第一行是「用户名」（只读行），不再保证「模型」是第一个。
    const row = rowByLabel('模型')
    // ★ 右边那格写的是**别名**（§7.3 / §7.4）—— 型号名只在设置里翻开来才露。
    //   写型号名不只是难读，还等于把他用的是谁家摊在这一页上。
    expect(row.querySelector('.account-row-value')?.textContent).toBe('我的便宜货')
    expect(container.textContent).not.toContain('deepseek-chat')

    await act(async () => {
      row.click()
      await new Promise(r => setTimeout(r, 0))   // 切页那一次渲染
      await new Promise(r => setTimeout(r, 0))   // 新页挂载时那一次"拉清单"
    })
    // 前提：那一页**真的开着**（少了这一句，下面那条地址断言会因为"什么都没渲染"假绿）
    expect(container.querySelector('.models')).toBeTruthy()
    expect(container.querySelector('.models-title')?.textContent).toBe('模型设置')
    // 地址栏也得跟着走 —— 这一页可以直接发链接、也可以 F5（`pathOf` 少一行就断）
    expect(location.pathname).toBe('/app/models')
  })

  it('★ 模型清单拿不到时，那一行右边那格**不出现**（不许替他写「默认」）', async () => {
    // 和「0 张作品」一模一样的毛病（§3.6 + 《文案规范》§3）：写「默认」等于
    // 替一个**接了自己模型**的人声明"你没接"。宁可少说一句，不说一句假的。
    // 变异：拿不到时画「默认」（= 第一版那种"给个看起来正常的默认值"）→ 这一条红。
    withModelsError('SENTINEL-模型清单拉不回来')
    await renderApp()
    await openAccount()

    const row = rowByLabel('模型')
    expect(row.querySelector('.account-row-value')).toBeNull()
    // 少一格不挡路：这一行照样点得进去
    expect(row.disabled).toBe(false)
  })

  it('modelValue：说得出"在用哪几套"，一套都没接才叫「默认」（§7.4）', () => {
    // 两个类别各自独立 —— 所以他可能"对话接了、图片没接"，
    // 那时候写「默认」是错的（有一半不是默认）。
    expect(modelValue([])).toBe('默认')
    expect(modelValue([MODEL(1, { active: true, alias: '我的便宜货' }), MODEL(2)])).toBe('我的便宜货')
    expect(modelValue([
      MODEL(1, { kind: 'chat', active: true, alias: '我的便宜货' }),
      MODEL(2, { kind: 'image', active: true, alias: '那个贵的' }),
    ])).toBe('我的便宜货、那个贵的')
    // 两栏各存一套同名的很常见 —— 写两遍像出了错
    expect(modelValue([
      MODEL(1, { kind: 'chat', active: true, alias: '出差那套' }),
      MODEL(2, { kind: 'image', active: true, alias: '出差那套' }),
    ])).toBe('出差那套')
    // 变异：只看第一套 / 不去重 / 一套都没有时也写个别名 → 这一条红
  })

  /**
   * ★ 滤镜（Task 10，设计 §5.1）：左栏「个人设置」里的第 4 格 + 它点进去那一页。
   *
   * 这一页是那个功能的**入口** —— 用户第一次拿到滤镜就是从这儿。它守四件事，
   * 每一件错了都不报错：
   *   · 清单的**四态**：还没到手 ≠ 空。拿空数组去顶"还没拉到"的后果是——
   *     一个导了 20 个滤镜的人进这一页先看到一句"你一个都没有"（和「0 张作品」
   *     同一个毛病，《文案规范》§3）；
   *   · 导入那条路的**三个失败点**（太大 / 解不开 / 服务端不认）各有各的话 ——
   *     都说"导入失败"的话，用户不知道该换文件、重新下载、还是改个名字；
   *   · 删除前先说清代价（`lutUsage` 回的那个 N 是那句话**唯一**的依据）；
   *   · 满 30 个时那颗导入按钮得真的按不动。
   */
  const LUTM = (id: number, over: Partial<LutMeta> = {}): LutMeta =>
    ({ id, name: `滤镜${id}`, size: 33, bytes: 240 * 1024, createdAt: 0, ...over })

  /** 多放几拍宏任务：导入那条链上有好几段 `await`（读文件 / 建 / 重拉清单）。 */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
  }

  /** 往那个藏起来的 `input[type=file]` 里塞一个文件（照 `uploadPhoto` 那个写法）。 */
  async function importFile(file: File) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input, '这一页那个藏起来的文件输入框不在').toBeTruthy()
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
    })
  }

  /** 列表里叫这个名字的那一行。 */
  const lutRow = (name: string) => [...container.querySelectorAll('.luts-row')]
    .find(r => (r.textContent ?? '').includes(name))

  /** 一行里的某颗按钮（按字找 —— 位置是排版的事，字才是用户的认知）。 */
  const btnIn = (row: Element | undefined, text: string) =>
    [...(row?.querySelectorAll('button') ?? [])]
      .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement

  it('★ 左栏点「Lut」能进那一页；导入一个 .cube 之后列表里出现它', async () => {
    // 两半都是**真行为**：那一格点得进去（地址栏跟着走 —— F5 / 收藏 / 转发都要认），
    // 以及选完一个文件之后清单里**真多出一行**（不是"按钮亮了"就算完）。
    // ★ 2026-10-06（深夜）：入口从「个人设置的调色素材那一格」换成**左栏那一支** ——
    //   用户：「这个可以从设置里面去掉了，我们的导航栏已经有了」（同一个
    //   `kind: 'luts'` 两个入口，谁都得先判断一下"这俩是不是一个地方"）。
    const SUNSET = LUTM(9, { name: 'sunset', size: 2, bytes: 1234 })
    // 清单里**什么时候**有它：导入之后 —— 拿 `createLut` 被调过没有当判据，
    // 而不是数"第几次拉"（探身进实现里数次数，加一处调用就悄悄错位）。
    // ⚠️ 基线要**当场量**：这个文件没有 `clearMocks`，`createLut` 的调用记录
    //    是跨用例活着的（同文件里 T9 那条注释提过同一个坑）。
    const importedBefore = vi.mocked(lutsMod.createLut).mock.calls.length
    vi.mocked(lutsMod.listLuts).mockImplementation(async () =>
      ({ luts: vi.mocked(lutsMod.createLut).mock.calls.length > importedBefore ? [SUNSET] : [] }))
    vi.mocked(lutsMod.createLut).mockResolvedValue({ lut: SUNSET })

    await renderApp()
    await goNav('Lut')

    expect(location.pathname).toBe('/app/luts')
    // 前提：这一页**真的开着**（少了它，下面那条会因为"整页没渲染"假绿）
    // ⚠️ 这里**不钉死那几个字**（★ 2026-10-05）：标题是用户自己定的文案，
    //   他刚把它从「滤镜」改成了「Lut」。这条断言的本意只是"这一页开着"，
    //   钉死字样的话他每改一次文案这里就红一次，而红的地方跟它要守的东西无关
    //   （文案该不该这么写是《文案规范》和人的事，不是这条测试的事）。
    expect(container.querySelector('.luts-title')?.textContent?.trim()).toBeTruthy()
    // 真的一个都没有 —— 这才是说「还没有导入过滤镜。」的时候
    expect(container.textContent).toContain('还没有导入过 Lut')

    await importFile(new File([CUBE2_TEXT], 'sunset.cube', { type: 'text/plain' }))

    // `createLut` 收到的是**名字 + 原文**：这个名字来自"文件名去扩展名"
    //（这个 cube 里没有 TITLE —— 有的话 TITLE 优先，服务端也认这一套次序）
    expect(vi.mocked(lutsMod.createLut)).toHaveBeenCalledWith('sunset', CUBE2_TEXT)
    // 清单里真多出一行，三样都在：名字 · N 级 · 体积（体积走 `formatSize`）
    const line = lutRow('sunset')
    expect(line).toBeTruthy()
    expect(line?.textContent).toContain('2 级')
    expect(line?.textContent).toContain('1 KB')
  })

  /**
   * ★ 2026-10-05：**左栏那颗「滤镜」**（用户：「把滤镜导入放到导航里吧，然后我没看到
   * 怎么去调用 lut 文件」）——他找不到那一页，也找不到**调用**的地方。
   *
   * 这一条把新开的那条路整条走一遍：左栏点「滤镜」→ 那一页 → 点「去套在照片上」
   * → 落到**调色**屏，而且面板里那一栏**是开着的**（不用再自己找一次 —— 他刚
   * 说过找不到）。少了最后那半截，新按钮只是把人送回一屏他刚才没找到东西的地方。
   */
  it('★ 左栏「Lut」进得去那一页；那儿的「去套在照片上」落到调色、而且那一栏是开着的', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [LUTM(1, { name: '黄昏' })] })
    await renderApp()
    await uploadPhoto()

    await goNav('Lut')
    expect(location.pathname).toBe('/app/luts')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('Lut')

    // 那一颗只在**真有滤镜**时出现（一个都没有时它把人送去一个空 picker，
    // 而该做的事明明是先导入 —— 见组件里那段）
    const go = [...container.querySelectorAll('.luts-go-use')][0] as HTMLButtonElement
    expect(go).toBeTruthy()
    await act(async () => { go.click(); await settle() })

    expect(location.pathname).toBe('/app/adjust')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('调色')
    // 到地方了，而且**已经是开着的**（不用再点一次「滤镜」那一行）
    expect(container.querySelector('.lut-grid')).toBeTruthy()
  })

  it('★ 清单拿不到时：那一页说**服务端那句话**，不说「还没有导入过 Lut」', async () => {
    // 「还没有导入过 Lut」对着一个导过 20 个、只是网络抖了一下的人就是句**假话**
    // （把"拿不到"编造成"你没有"）。
    // ⚠️ 第一发（App 挂载那一次）**照常给一份名单**：`useLuts` 拿到失败会在控制台
    //    留一行「滤镜清单没取回来」—— 那是别的用例的噪声，会盖住真话（给的那份是空
    //    名单，这一条量的是"那一页拿不到"，与 App 那份无关）。
    // ★ 2026-10-06（深夜）：入口从「个人设置那一格」换成**左栏那一支** ——
    //   用户把设置里那格撤了（见 `AccountPage` 那段注释）。
    vi.mocked(lutsMod.listLuts)
      .mockResolvedValueOnce({ luts: [] })
      .mockRejectedValue(new api.ApiError('UPSTREAM_FAILED', 'SENTINEL-滤镜清单拉不回来'))
    await renderApp()
    await goNav('Lut')

    // 说的必须是**服务端那句话**（原样），不是我们替它总结的
    expect(container.textContent).toContain('SENTINEL-滤镜清单拉不回来')
    expect(container.textContent).not.toContain('还没有导入过 Lut')
  })

  it('★ 还没到手的时候是「正在打开…」，不是「还没有导入过 Lut」', async () => {
    // 这一条钉的就是"不许拿空数组顶还没拉到"：那一句"你一个都没有"，
    // 只许在**真的拉到了空清单**之后说。
    const gate = makeGate<{ luts: LutMeta[] }>()
    vi.mocked(lutsMod.listLuts).mockReturnValue(gate.promise)
    await renderApp()
    // 只切页，不放行请求 —— 要的就是"还在路上"那一瞬间
    await goNav('Lut')

    expect(container.textContent).toContain('正在打开')
    expect(container.textContent).not.toContain('还没有导入过 Lut')

    // 放行 —— 这回是真的空，那句话才是事实
    await act(async () => { gate.open({ luts: [] }); await settle() })
    expect(container.textContent).toContain('还没有导入过 Lut')
  })

  it('★ 导入的三个失败点各有各的话 —— 而且都不会落到一次导入上', async () => {
    // 三条路**不能都说"导入失败"**：用户拿到那句话要知道该改什么 ——
    // 换个文件（太大 / 坏了），还是改个名字（重名）。三句都是**原样**显示
    //（太大那句是 spec §6.3 冻死的，和 `server/luts.ts` 一字不差）。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [] })
    vi.mocked(lutsMod.createLut).mockRejectedValue(
      new api.ApiError('BAD_REQUEST', '已经有一个叫「sunset」的 Lut 了，换个名字。'))
    await renderApp()
    await goNav('Lut')
    await settle()

    // ① 太大：**连读都不读**（8 MB 那个上限在前，解析在后）
    await importFile(new File([new Uint8Array(MAX_LUT_FILE_BYTES + 1)], 'big.cube'))
    expect(container.textContent).toContain('这个文件超过 8 MB 了。')
    expect(vi.mocked(lutsMod.createLut)).not.toHaveBeenCalled()

    // ② 解不开：`parseCube` 那句话本来就是给用户看的中文（这里是一份普通文本）
    await importFile(new File(['这不是滤镜'], 'x.cube'))
    expect(container.textContent).toContain('不是 .cube 格式')
    expect(vi.mocked(lutsMod.createLut)).not.toHaveBeenCalled()

    // ③ 本地过了、服务端不认（重名 / 满了 / 空间满了）—— **原样**显示它那句话
    await importFile(new File([CUBE2_TEXT], 'sunset.cube'))
    expect(vi.mocked(lutsMod.createLut)).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已经有一个叫「sunset」的 Lut 了，换个名字。')
  })

  it('★ 改名：就地展开一个输入框，提交打的是 renameLut(id, 新名字)', async () => {
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.renameLut).mockResolvedValue({ lut: { ...HUT, name: '日落' } })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '改名').click() })
    const input = container.querySelector('input[name=lutName]') as HTMLInputElement
    expect(input).toBeTruthy()
    // 预填现在的名字：改起来只动要动的那几个字（和详情页那颗「改名」同一条）
    expect(input.value).toBe('黄昏')

    await act(async () => { type(input, '日落') })
    await act(async () => {
      (container.querySelector('.luts-rename button[type=submit]') as HTMLButtonElement).click()
      await settle()
    })

    expect(vi.mocked(lutsMod.renameLut)).toHaveBeenCalledWith(7, '日落')
  })

  it('★ 删除：先问"还有几条会话在用"，那句话里的 N 对得上；确认了才真删', async () => {
    // 删除前那次 `lutUsage` 是确认块里那个 N 的**唯一**依据（spec §6.4）——
    // 猜一个数、或者干脆不说，都是在让用户闭着眼睛删。
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.lutUsage).mockResolvedValue({ sessions: 2 })
    vi.mocked(lutsMod.deleteLut).mockResolvedValue({ ok: true })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '删除').click(); await settle() })

    expect(vi.mocked(lutsMod.lutUsage)).toHaveBeenCalledWith(7)
    const ask = container.querySelector('.luts-ask')
    expect(ask?.textContent).toContain('还有 2 条老会话在用这个 Lut')
    expect(ask?.textContent).toContain('变回没有 Lut 的样子')
    // **还没删**：点「删除」只是把代价摊开，删除请求一条都还没发
    expect(vi.mocked(lutsMod.deleteLut)).not.toHaveBeenCalled()

    await act(async () => {
      (ask?.querySelector('.luts-delete') as HTMLButtonElement).click()
      await settle()
    })
    expect(vi.mocked(lutsMod.deleteLut)).toHaveBeenCalledWith(7)
  })

  it('★ 没人用这个滤镜时，确认块说的是「删了就找不回来了。」', async () => {
    // 两句话的分界就是 `sessions > 0` —— 对着一个没人用的滤镜说"还有老会话在用"
    // 同样是假话（只是方向相反）。
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.lutUsage).mockResolvedValue({ sessions: 0 })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '删除').click(); await settle() })

    const ask = container.querySelector('.luts-ask')
    expect(ask?.textContent).toContain('删了就找不回来了。')
    expect(ask?.textContent).not.toContain('老会话')
  })

  it('★ 满 30 个：导入按钮禁用，还说一句「最多 30 个 Lut」', async () => {
    // 上限是 `MAX_LUTS`（服务端也拦，但拦下来是一趟白跑的请求）。
    // 只禁按钮不说话，用户只会以为按钮坏了 —— 两句要一起。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({
      luts: Array.from({ length: 30 }, (_, i) => LUTM(i + 1)),
    })
    await renderApp()
    await goNav('Lut')

    const btn = container.querySelector('.luts-import') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain('最多 30 个 Lut')
  })

  it('formatSize：三档各说一句话（§3.6 那张图只画了 MB 那一档）', () => {
    // 变异：把 MB / GB 那两档写反，或者给 MB 也留小数 → 这一条红。
    const MB = 1024 * 1024
    expect(formatSize(240 * 1024)).toBe('240 KB')
    expect(formatSize(342 * MB)).toBe('342 MB')
    expect(formatSize(1.5 * 1024 * MB)).toBe('1.5 GB')
  })
})
