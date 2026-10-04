import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { logout, type AccountUser } from '../api/account.ts'
import { listModels, type PublicConfig } from '../api/models.ts'
import { listWorks } from '../api/works.ts'
import type { View } from './view.ts'

/**
 * 用户管理（§3.6）。**先只做骨架**，它是 §12 的第三段。
 *
 * 现在有：用户名 / 使用情况 / 模型 / 退出登录，四个都真能用。
 * 还差（各自等依赖到位）：默认导出尺寸、默认风格、本地文件夹、深色浅色 ——
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
 * 第一版正是在这儿错了：App 传死一个 `workCount={0}`，对谁都写"0 张作品"。
 */
type Usage =
  | { state: 'loading' }
  | { state: 'ready'; count: number; bytes: number | null }
  | { state: 'unavailable' }

export function AccountPage({
  user, onGo, onSignedOut,
}: {
  user: AccountUser
  onGo: (v: View) => void
  onSignedOut: () => void
}) {
  const [leaving, setLeaving] = useState(false)
  const [usage, setUsage] = useState<Usage>({ state: 'loading' })
  /**
   * 模型清单（§3.6 那一行右边要写「别名」还是「默认」得看它）。
   * `null` = 还没拿到 / 拿不到 —— 两种情况**都整格不出现**，见下面对应的注释。
   */
  const [models, setModels] = useState<PublicConfig[] | null>(null)

  useEffect(() => {
    // 拉一次「全部作品的元数据」。这个接口**一张图都不带**（§3.5 把"名单本"和
    // "图片柜"分开正是为了这个），几十上百张也就是几 KB，而且不走 AI、不花钱。
    //
    // ⚠️ `alive`：这页是"看一眼就走"的，请求回来之前人可能已经登出/切页了 ——
    //    晚到的响应不该再写进一棵已经不存在的树上（写进去就是一次 React 警告，
    //    而且是一个"看不见的页面在背后改状态"的形状）。
    let alive = true
    listWorks().then(
      (ws) => {
        if (!alive) return
        // 每张都得有一个像样的体积才算得出来。**有一个不对就不算**（回 null =
        // 只显示张数），而不是把缺的那几张当 0 —— 那会把总量报小，也是假话。
        const usable = ws.every((w) => Number.isFinite(w.bytes) && w.bytes >= 0)
        setUsage({
          state: 'ready',
          count: ws.length,
          bytes: usable ? ws.reduce((n, w) => n + w.bytes, 0) : null,
        })
      },
      () => { if (alive) setUsage({ state: 'unavailable' }) },
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

  return (
    <div className="account">
      {/* ★ 2026-10-04：**给这个名字加了个「用户名」的标签**。用户看完这一页说
          「用户名没显示出来」—— 屏幕上本来只有孤零零一个名字（他那个测试账号
          就叫 111），读起来像个编号，看不出它是"你的用户名"。

          ⚠️ 标签**必须另起一格**，不能塞进 `.account-name` 里面：
          `App.test.tsx` 是按 `.account-name` 的 **textContent 恰好等于用户名**
          来钉这一格的（两条）。塞进去的话，那两条会红成"用户名变成『用户名111』"
          —— 看着像数据错了，其实只是标签放错了地方。 */}
      <p className="account-label">用户名</p>
      <h1 className="account-name">{user.username}</h1>

      {/* 使用情况（§3.6 那两格）。**拿不到就整格不出现** —— 见上面 Usage 那段。 */}
      {usage.state !== 'unavailable' && (
        <div className="account-stats">
          {usage.state === 'loading' ? (
            // 占位用「…」不用 0：这一格马上就会被真数替掉，而"0"读起来是关于
            // 用户资产的**一句断言**，哪怕只闪半秒也不该是假的。
            <div className="stat"><b>…</b><span>张作品</span></div>
          ) : (
            <>
              <div className="stat"><b>{usage.count}</b><span>张作品</span></div>
              {/* 体积：只有算得出来、而且确实存着东西的时候才画（0 张时
                  「0 KB」是句没用的话）。服务端没给全就算不出来 —— 那就不说。 */}
              {usage.count > 0 && usage.bytes !== null && (
                <div className="stat"><b>{formatSize(usage.bytes)}</b><span>占的空间</span></div>
              )}
            </>
          )}
        </div>
      )}

      <div className="account-rows">
        {/* 模型那一行（§3.6）。显示的是**别名或者「默认」**，绝不是型号（§7.3）——
            点进去是模型设置那一页（`{ kind: 'models' }`）。
            ⚠️ 那一格写别名：用户一眼认出"就是我起的那套"；写型号名不只是难读，
               还等于把他用的是谁家摊在屏幕上。 */}
        <button className="account-row" onClick={() => onGo({ kind: 'models' })}>
          <span className="account-row-label">模型</span>
          {/* 拿不到名单时这一格整个不出现（见上面那个 effect 的注释）——
              「默认」两个字在那种情况下是一句没根据的话。 */}
          {models !== null && <span className="account-row-value">{modelValue(models)}</span>}
          <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} /></span>
        </button>
      </div>

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
      {/* ⚠️ 注销账号**这一版不做**：它会连带删掉作品和文件，
          而"删了什么、能不能后悔"还没有定案（§11）。不留一个点了会出事的按钮。 */}
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
