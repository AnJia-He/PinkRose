import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  changePassword, deleteAccount, logout, usage as fetchUsage,
  type AccountUser,
} from '../api/account.ts'
import { ApiError } from '../api/client'
import { listModels, type PublicConfig } from '../api/models.ts'
import { listLuts } from '../api/luts.ts'
import { Btn } from './kit/Btn.tsx'
import { Field, TextInput } from './kit/Field.tsx'
import type { View } from './view.ts'

/**
 * 用户管理（§3.6）。**先只做骨架**，它是 §12 的第三段。
 *
 * 现在有：用户名 / 使用情况 / 模型 / 改密码 / 注销账号 / 退出登录。
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
 *
 * ★ 2026-10-04：数据源从"前端把整份作品清单拉下来自己加"换成了
 *   `GET /api/me` 的 `usage` —— 那边**把会话占的空间也算进去了**
 *   （会话里的原图和每一步的底也是用户的文件），前端那份只看得见作品。
 */
type Usage =
  | { state: 'loading' }
  | { state: 'ready'; count: number; bytes: number; limit: number }
  | { state: 'unavailable' }

/** 网络错误那句话：服务端说了什么就转什么，没说的给一句能照着做的。 */
const why = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

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
  /**
   * 滤镜有几个（第 4 格右边那个「N 个」，★ 2026-10-05）。
   * `null` = 还没拿到 / 拿不到 —— 和上面那条**同一条规矩**：整格不出现。
   * 写「0 个」对着一个导了 20 个滤镜的人就是一句假话（《文案规范》§3）。
   */
  const [lutCount, setLutCount] = useState<number | null>(null)

  // 改密码那一段（§6.5）和注销那一段（§5）各自的开合与状态
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [delOpen, setDelOpen] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [delMsg, setDelMsg] = useState<string | null>(null)

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

  useEffect(() => {
    // 「滤镜」那一格右边写「N 个」得知道有几个（★ 2026-10-05）。
    // 和上面两条一样是"看一眼就走"的，所以一样要 `alive`；拿不到也**什么都不说**
    // （`lutCount` 留在 null）—— 这一行本身照常点得进去，少一格不挡路。
    let alive = true
    listLuts().then(
      (r) => { if (alive) setLutCount(r.luts.length) },
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
      (e) => setPwMsg({ tone: 'err', text: why(e, '没改成，过一会儿再试。') }),
    ).finally(() => setPwBusy(false))
  }

  const confirmDelete = () => {
    if (delBusy) return
    setDelBusy(true)
    setDelMsg(null)
    // 成功之后**整页都属于一个不存在的账号了** —— 直接告诉 App 走人
    //（和退出登录同一条出口：App 收到就把登录页换上）。
    deleteAccount().then(
      onSignedOut,
      (e) => { setDelBusy(false); setDelMsg(why(e, '没注销成，过一会儿再试。')) },
    )
  }

  /** §6.6 的 80% 提醒：那一格数字变色 + 下面那句带出路的提醒，都由它决定。 */
  const usageWarn = usage.state === 'ready' && usage.bytes / usage.limit >= 0.8

  return (
    <div className="account">
      {/* ★★ 2026-10-04（晚）：用户说「布局看着都不合理」→ 第一次有了标题 + 一张列表卡。
          ★ 2026-10-05：他又说「**因为整体的空间还有很多空余，所以我想设计成一个个小框架**」
          → 一列窄卡通吃改成**三个小框架排一行**（一类一框：账号 / 模型配置 / 作品空间用量），
          把右边空着的地方用起来。他在画板上看过的样子：
          `.superpowers/brainstorm/430-1791133449/content/account-tiles.html`。
          窄屏网格自己叠（中屏两列、手机一列）—— `auto-fit + minmax` 干的事。
          ⚠️ 展开的表单 / 确认跟着**所在的那一框**走（改密码、注销都在「账号」框里往下长）。 */}
      <h1 className="account-title">个人设置</h1>

      <div className="account-grid">
        {/* ① 「账号」框：我是谁 + 账号安全那两件 */}
        <section className="account-tile">
          <h2 className="account-tile-title">账号</h2>
          <div className="account-card">
            {/* 用户名：它不是一个"可点的设置"，但放在这一框的最上面最自然
                （设置页的第一行十有八九就是"你是谁"）。

                ⚠️ `.account-label` / `.account-name` 这两个类**是测试的锚点，改版也不许删**：
                `App.test.tsx` 有两条断言钉着「用户名这三个字在」和「`.account-name`
                恰好等于用户名」（后者是防"标签被塞进名字里"的那种错法）。 */}
            <div className="account-row account-row-static">
              <span className="account-row-label account-label">用户名</span>
              <span className="account-row-value account-name">{user.username}</span>
            </div>

            {/* 账号那两件（§3.6 那张图上的 改密码／注销账号）。
                ⚠️ 「退出登录」**不在这张卡里**（见下面那颗按钮的注释）—— 它是"离开这一页"，
                不是这一页上的一项设置，收进来就把两种东西混成一种了。 */}
            <button className="account-row" aria-expanded={pwOpen}
              onClick={() => setPwOpen((o) => !o)}>
              <span className="account-row-label">改密码</span>
              <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
            <button className="account-row account-row-danger" aria-expanded={delOpen}
              onClick={() => setDelOpen((o) => !o)}>
              <span className="account-row-label">注销账号</span>
              <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
          </div>

          {/* 改密码的表单（§6.5）。⚠️ 服务端改完会发一张新票 —— 所以这一改等于把
              **所有设备**踢下线；当前这台拿到新票、不会掉，别在界面里吓唬人。 */}
          {pwOpen && (
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
          {delOpen && (
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
              {models !== null && <span className="account-row-value">{modelValue(models)}</span>}
              <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
          </div>
        </section>

        {/* ③ 「作品空间用量」框（§3.6 / §6.6）。**拿不到就整个框不出现** ——
            见上面 Usage 那段（不能说成"0"，也不能画一个空壳子）。
            ⚠️ 原来行首那个「使用情况」标签删了：这一框的小标题就是它，
            同一个意思不说两遍。 */}
        {usage.state !== 'unavailable' && (
          <section className="account-tile">
            <h2 className="account-tile-title">作品空间用量</h2>
            <div className="account-card">
              {/* ★ 2026-10-05：用量饼图（用户：「这一整块都可以先放作品用量，
                  用那个立体的大一点的圆盘图表表示」→ 看完圆环后又补
                  「我想到了就是磁盘用量是一个叫做饼图的」→ 换成实心饼图）——
                  **整块让给图表**：饼图居中在上、百分比 + 两个数字在下面
                  （`.usage-figure`）。盘 `aria-hidden`：语义真值在数字里，
                  它是"画给人看"的那份。 */}
              <div className="usage-figure">
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

        {/* ④ 「调色素材」框（★ 2026-10-05，设计 §5.1）：滤镜那一页的入口。
            右边写**几个** —— `lutCount` 拿不到时那一格整格不出现，
            和「模型」那一行同一条规矩（不许说一句没根据的话）。 */}
        <section className="account-tile">
          <h2 className="account-tile-title">调色素材</h2>
          <div className="account-card">
            <button className="account-row" onClick={() => onGo({ kind: 'luts' })}>
              <span className="account-row-label">滤镜</span>
              {lutCount !== null && <span className="account-row-value">{lutCount} 个</span>}
              <span className="account-row-go" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
          </div>
        </section>
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
 * ⚠️ 百分比数字在饼**下面**（顶面上压字对比度会随占比漂）。
 * ⚠️ 大字行写的是**剩余率**（见下面 `restPct` 的注释）；「>99.9%」是它的诚实上限
 *    写法，和以前「<0.1%」一个道理 —— 不假装精确到没有的小数位。
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
  /**
   * 大字行显示的是**剩余率**（★ 2026-10-05 第九轮。用户先看到裸着的「<0.1%」说
   * 「这个数字你得告诉用户是什么呀」，补了「已用」前缀；接着又说
   * 「**这不还是用的量不是剩余量呀**」—— 他要这行看**剩余**的视角。
   * 说穿了："还剩多少"才是他打开这页的问题，已用是答完之后的余数）。
   *
   * 格式化规则和老口径（已用）**互为镜像**：剩余 >99.95% 写「>99.9%」
   *（对应老口径的「<0.1%」），90~99.9 一位小数，≤90 取整；真的全满时显示
   * 「剩余 0%」—— 那是真话，不是「0.0%」那种假话。
   */
  const restPct = ratio === null ? null : Math.max(0, Math.min(100, 100 - ratio * 100))
  const label = restPct === null ? ''
    : restPct > 99.95 ? '>99.9%'
    : restPct > 90 ? `${restPct.toFixed(1)}%`
    : `${Math.round(restPct)}%`
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
      {/* 百分比那行（★ 2026-10-05 第八/九/十轮：先补主语「已用」（用户：「这个数字
          你得告诉用户是什么呀」）→ 翻成剩余视角（「这不还是用的量不是剩余量呀」）
          → 第十轮：「剩余」和数字**并成一行**（用户：「字体和颜色应该跟数字保持
          一致吧看着好别扭」—— 小灰标签贴大数字的混搭他不认，整行 22px 一个款式；
          warn 时也整行一起红）。读屏读出来是「剩余 99.7%」。 */}
      {label !== '' && <span className="usage-pie-pct">剩余 {label}</span>}
    </div>
  )
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
