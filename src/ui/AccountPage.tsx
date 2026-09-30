import { useState } from 'react'
import type { AccountUser } from '../api/account.ts'
import { post } from '../api/client.ts'

/**
 * 用户管理（§3.6）。**先只做骨架**，它是 §12 的第三段。
 *
 * 现在有：用户名 / 使用情况 / 退出登录，三个都真能用。
 * 还差（各自等依赖到位）：默认导出尺寸、默认风格、本地文件夹、深色浅色 ——
 * 正合 §12 自己那句「每段做完都能单独用、单独验收」。
 *
 * ⚠️ **「模型」那一行故意不在这儿**：`{ kind: 'models' }` 这个视图今天还不存在
 * （Task 9 才立起来），先挂上去就是一颗"点了哪都不去"的按钮 —— 这个项目不留
 * 那种按钮。等 Task 9 把那一页做出来，再把这一行加上（连同 `onGo` 一起）。
 *
 * ⚠️ 页面上**不许出现我们自己用的模型名或接口地址**（§7.3）。
 * 用户看到的只有「默认」和别名 —— 型号名对他没意义，限制才有意义。
 */
export function AccountPage({
  user, workCount, onSignedOut,
}: {
  user: AccountUser
  workCount: number
  onSignedOut: () => void
}) {
  const [leaving, setLeaving] = useState(false)

  return (
    <div className="account">
      <h1 className="account-name">{user.username}</h1>

      {/* 计数来自调用方传进来的那一份，**不额外发一次请求** ——
          用户管理是个"看一眼就走"的页面，为了一个数字去多打一趟接口不值。 */}
      <div className="account-stats">
        <div className="stat"><b>{workCount}</b><span>张作品</span></div>
      </div>

      <button
        className="account-signout"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          // 退出是幂等的、而且不该因为网络失败就把用户困住 ——
          // 服务端那条路本来就不读请求体、只清一个 cookie。
          // 变异：删掉这个 `.catch` → 「请求失败也要放人走」那条测试会红
          //      （`.then(onSignedOut)` 挂在一条已经 reject 的链上，永远不会执行）。
          post('/api/logout', {}).catch(() => {}).then(onSignedOut)
        }}
      >{leaving ? '正在退出…' : '退出登录'}</button>
      {/* ⚠️ 注销账号**这一版不做**：它会连带删掉作品和文件，
          而"删了什么、能不能后悔"还没有定案（§11）。不留一个点了会出事的按钮。 */}
    </div>
  )
}
