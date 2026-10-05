import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { BtnLink } from './kit/Btn.tsx'
import { getWork, renameWork, deleteWork, fullUrl } from '../api/works'
import { workName, type WorkMeta, type WorkDetail } from '../../shared/works.ts'
import { buildFilename } from '../export/save'
import { PARAM_LABELS, PARAM_KEYS, clampAdjustments, isChanged, type Adjustments } from '../../shared/adjustments.ts'

/**
 * 详情页那个「下载到我的电脑」下下来叫什么。
 *
 * **`<a download>` 必须带值**：不带值时浏览器拿 URL 末段当文件名 ——
 * 现在末段是 `file`（还可能跟着 `?v=…`），下下来就是一个**没有扩展名**的文件，
 * 手机相册和看图软件认不出它。而编辑页那条下载走的是 `buildFilename()`（`p_xxx.jpg`）,
 * 同一个动作两种结果。
 *
 * 名字的来源：别名优先（那是用户自己起的名字），没起名就用 id ——
 * **不拿 `workName` 当文件名**：它没起名时是「11月15日 06:13」，中间那个 `:` 在
 * Windows 上根本写不出去（而且斜杠、引号这些在别的系统上也不行）。
 * 别名是用户手打的，同样可能要过这一关 —— 一并换成 `_`。
 *
 * ⚠️ 用的是**和编辑页同一个** `buildFilename`（`_pinkrose` 那个后缀、扩展名从格式推），
 * 不另造一套命名规则。
 */
export function downloadName(w: WorkMeta): string {
  const stem = (w.alias ?? `作品${w.id}`).replace(/[\\/:*?"<>|]/g, '_').trim() || `作品${w.id}`
  return buildFilename(stem, 'image/jpeg')
}

/**
 * 一张作品的详情页 —— **「这张图怎么来的」**（spec §3.5.1）。
 *
 * 这一页最有产品想法的地方是那个**永远分成两栏的配方**：
 *
 * > 调色是配方，AI 编辑是这张图的经历。配方能带走，经历带不走。
 *
 * 混在一起，用户会以为"这一整套都能复用" —— 而「把后面那个人去掉」只对**这张
 * 照片的这个人**有意义，换一张就是另一回事。所以：
 *   · 调色那栏有「套用」，而且**没有图的时候是禁用的**（裁定 ⑤：套了显示不出来，
 *     而且下一次上传会被 `setParams(ZERO)` 悄悄清掉 —— 那就成了骗人）；
 *   · AI 那栏**一个按钮都没有**。给了就是在骗人。
 */
export function WorkDetailPage({ id, onBack, onApply, canApply }: {
  id: number
  onBack: () => void
  /** ★ 2026-10-05（滤镜，T12）：**连名字和强度一起**交出去 —— App 那边按名字去
   *  清单里找还没被删的那一个（配方里只存名字，id 对已经烤好的图没有意义）。 */
  onApply: (params: Adjustments, lut: { name: string; amount: number } | null) => void
  canApply: boolean
}) {
  const [work, setWork] = useState<WorkDetail | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getWork(id).then(
      (w) => { if (alive) setWork(w) },
      (e) => { if (alive) setFailed(e instanceof Error ? e.message : '打不开这一张') },
    )
    return () => { alive = false }
  }, [id])

  /**
   * 「现在」——**一次挂载只取一次**（跨年那一刻不会自己翻新，和 `GalleryPage` 同款）。
   *
   * ⚠️ **它必须住在这两个 return 之前。** 这一页上面还有两条 early return
   * （加载中 / 打不开），顺手把 hook 写在它们下面是个**当场炸**的错：
   * 第一趟 `work` 还是 null（少一个 hook）、第二趟拿到了（多一个）——
   * React 报的是 `Rendered more hooks than during the previous render.`，
   * 四条详情页用例**一起**红在那句上，跟它们各自要守的东西毫无关系。
   * 规则就一句：**hook 只在组件最顶上、无条件执行。**
   *
   * ⚠️ 值也必须是"现在"，不能图省事传 `work.updatedAt`：`workName` 把 `now` 交给
   * `dayLabel`，而 `dayLabel` 只在**跨年**时才补上「2023年」—— 传 `work.updatedAt`
   * 的话"已经过去多久"永远是 0，年份**永远不显示**。后果是**同一个东西在两个屏幕上
   * 叫两个名字**：作品页说「2023年11月15日 06:13」，点进详情页变成「11月15日 06:13」。
   * 而 §3.5 的「名字就是日期所以搜日期也能搜到」正是建立在"名字只有一份"上的。
   * （这条有测试钉着：`.detail-name` 要含「2023年」。）
   */
  const now = useMemo(() => Date.now(), [])

  async function doRename(alias: string) {
    setRenaming(false)
    const next = alias.trim()
    if (next === (work?.alias ?? '')) return          // 没改就什么也不做
    setBusy(true)
    try {
      const got = await renameWork(id, next || null)   // 清空 = 改回用时间当名字
      setWork(w => (w ? { ...w, alias: got.alias } : w))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : '没改成，再试一次')
    } finally { setBusy(false) }
  }

  async function doDelete() {
    setConfirming(false)
    setBusy(true)
    try {
      await deleteWork(id)
      onBack()          // 删完回列表 —— 留在一个已经不存在的页面上最难受
    } catch (e) {
      setFailed(e instanceof Error ? e.message : '没删掉，再试一次')
      setBusy(false)
    }
  }

  if (failed && !work) return (
    <section className="detail">
      <p className="detail-error">{failed}</p>
      {/* §3.7：告诉用户"不行"的地方，都要同时告诉他"那怎么办"。
          这一屏原来**只有一句"不行"**（"没有这张作品"）—— 返回按钮在那儿不等于说了出路。
          **不新造按钮、不新造重试逻辑**：和作品页同一条出路、同一句话，
          `刷新一下页面，再试一次。` 两页一字不差（`.detail-hint` 和 `.gallery-hint` 同一套观感）。 */}
      <p className="detail-hint">刷新一下页面，再试一次。</p>
    </section>
  )
  if (!work) return <section className="detail"><p className="detail-loading">正在打开…</p></section>

  const name = workName(work, now)
  const { params: rawParams, edits } = work.recipe
  /** ★ **老数据缺新键 —— 归一化是唯一入口**（2026-10-04，「专业面板」Task 6）。
   *
   *  2026-10-04 之前存下来的作品，`recipe.params` 里只有那八根，新加的那七条
   *  （自然饱和度 / 色彩平衡三轴 / 分离色调）取出来是 `undefined`。不归一化的话
   *  两处一起坏，而且都不报错：
   *   · 下面那张表按 `isChanged`（判据是 `!== 0`）列 —— `undefined !== 0` 为真，
   *     七条新参数**全被判成"改过"**，每一行渲染出一个「… undefined」；
   *   · `onApply(params)` 那一按把它们直接送进 App 的 `setParams` —— 缺着键
   *     进状态，调色面板和色轮当场就是坏的（和会话恢复那条支线同一个病）。
   *  一行归一化把两处一起治好；缺的键落成 0（中立值），正好是"没动过"该有的样子。 */
  const params = clampAdjustments(rawParams)
  /** 这一张**真的改过**的那几个参数。
   *
   *  ⚠️ 原来八条全列，没动过的显示一个「—」。那条注释自己写着"0 就不列了 ——
   *  一排 0 只是噪音，用户要的是'改过什么'"，可代码给的是破折号，也就是**照样列**。
   *  这一页要回答的是"这张图怎么来的"，答案就是"改过这几样"；
   *  六个「—」夹着两个数字，读的人得自己从噪音里挑。
   *  （`PARAM_KEYS` 的顺序保留 —— 让"改过的"按调色面板那个固定顺序出现，
   *   而不是按用户点的先后乱跳。）
   *  ⚠️ "动过没有"走 `isChanged` —— 调色面板点亮滑块问的是同一件事，
   *  两处各判一次的话，哪天判据变了会出现**两个屏幕对同一张图说法不一致**。 */
  const changed = PARAM_KEYS.filter(k => isChanged(params, k))
  /** ★ 2026-10-05（滤镜，T12）：这一张配方里的滤镜。
   *
   *  ⚠️ **`?? null` 不是多余的**：2026-10-05 之前存的作品，库里那份 recipe JSON
   *  **没有 `lut` 这个键**，而 `handleGetWork` 是把库里的 JSON **原样**返回的
   *  （不走 `readRecipe`）—— 所以老作品读到的是 `undefined`，不是 `null`。
   *  `shared/works.ts` 里那句"读的人不必再判"只对 `readRecipe` 那条出口成立。
   *  在这一处归一化，下面显示 / 「原样」判据 / `onApply` 三处就都只剩 null 了。 */
  const lut = work.recipe.lut ?? null
  /** 「这一张是原样」那句的判据 —— ★ 2026-10-05：**带上滤镜**。
   *  有滤镜就不是"原样"（哪怕十五个参数一个都没动）——
   *  判据漏了它的话，屏幕上会一边列着「滤镜 黄昏」一边说"没有调过色"。 */
  const recipeEmpty = changed.length === 0 && !lut

  return (
    <section className="detail">
      <header className="detail-head">
        <button className="detail-back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />作品</button>
        {renaming ? (
          /* ⚠️ 2026-10-01：这一格**故意没过 `<Field>`** —— 它是"就地改名"，
             名字由它旁边的位置说明（它顶掉的就是那个 `<h1>`），加标签反而是多余的。
             又因为它是 `.detail-head` 那一行的 flex 孩子（`.rename-input` 身上有
             `flex: 1`），包一层会让那个 `flex: 1` 落错地方。可访问的名字直接给。 */
          <input className="rename-input" autoFocus defaultValue={work.alias ?? ''}
                 aria-label="作品名字"
                 onBlur={e => void doRename(e.target.value)}
                 onKeyDown={e => {
                   // ⚠️ `isComposing`：中文输入法**选词**也是回车 —— 不挡的话
                   //    用户打"海边"选词，名字会半截存成"海"（一声不吭）。
                   //    （2026-10-05 补；对话列表那颗「改名」自带这一条和它的测试）
                   if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                     void doRename((e.target as HTMLInputElement).value)
                   if (e.key === 'Escape') setRenaming(false)
                 }} />
        ) : (
          <>
            <h1 className="detail-name">{name}</h1>
            <button className="detail-rename" disabled={busy}
                    onClick={() => setRenaming(true)}>改名</button>
          </>
        )}
      </header>

      {failed && <p className="detail-error">{failed}</p>}

      {/* ⚠️ **两条都必须走 `fullUrl`（原图），不是 `fileUrl`。**
          `fileUrl` 那条是给**列表格子上那张小图**用的：`hasThumb` 时回 `/thumb`，
          而缩略图是个小图（≤480px，`GALLERY_THUMB_MAX_SIDE`；2026-09-25 之前是
          160px），且每次保存都顺手带一张 —— 也就是**几乎总是存在**。拿它当"大图"
          的后果实测过：点开一张看到的是那张小图，§3.5 的「看大图」不成立；
          而「下载到我的电脑」下到的也是同一张。

          下载那条尤其要紧：§3.4 已经把"保存自动下载"拿掉了，所以**这个按钮是用户
          把原图拿出服务器的唯一一条路**。§3.5 说"存满了先下载到本地再删，东西就不会
          丢"—— 下载的是缩略图的话，那句话就从"不丢"变成了**真的丢**（本地那份是
          缩略图，服务器上的原件随后被他自己删掉）。 */}
      <img className="detail-image" src={fullUrl(work)} alt={name} />

      <div className="detail-actions">
        {/* 下载给的是**存在服务器上的那一份**（裁定 ①：存的不是上传的原图，是导出
            用的那个产物，所以"看到的"和"下载到的"必须是同一个东西）—— 它和上面那张
            大图现在是**同一条 URL**，所以这句话今天成立；C1 之前它也写着这句，
            而当时两处拿到的都是缩略图，那句话是**假的**。

            `download` 带值（M2）：不带值时浏览器按 URL 末段起名 —— 现在末段是
            `file`（还带 `?v=…`），下下来是个没有扩展名的文件。 */}
        <BtnLink className="detail-download" href={fullUrl(work)} download={downloadName(work)}>下载到我的电脑</BtnLink>
        {confirming ? (
          <span className="detail-confirm">
            <span>删掉作品集里的这一份吗？删了就找不回来了。</span>
            {/* ⚠️ 这一颗带类名（`detail-delete`，和外面那颗开启确认的是同一个），
                样式才认得出"这是那个危险动作" —— 原来靠的是 `:first-of-type`
                这种 DOM 位置，把「取消」挪到前面（很常见的一次改动）就会让
                红/灰**静静地对调**，测试和评审都不会红。 */}
            <button className="detail-delete" onClick={() => void doDelete()} disabled={busy}>删掉</button>
            <button onClick={() => setConfirming(false)}>取消</button>
          </span>
        ) : (
          <button className="detail-delete" disabled={busy} onClick={() => setConfirming(true)}>删除</button>
        )}
      </div>

      <div className="how">
        <h2 className="how-title">这张图怎么来的</h2>

        {/* ⚠️ **两栏永远是两栏，别合**（§3.5.1）。调色是配方，AI 编辑是这张图的经历 ——
            配方能带走，经历带不走。合起来用户会以为"这一整套都能复用"。 */}
        <section className="recipe-box">
          <h3>调色</h3>
          <p className="recipe-note">这一套能套到别的图上</p>
          {recipeEmpty
            ? <p className="recipe-empty">这一张是原样，没有调过色。</p>
            : (
              <ul className="recipe-params">
                {changed.map(k => (
                  <li key={k}>
                    <span className="recipe-param-name">{PARAM_LABELS[k]}</span>
                    <span className="recipe-param-value">
                      {params[k] > 0 ? `+${params[k]}` : String(params[k])}
                    </span>
                  </li>
                ))}
                {/* ★ 2026-10-05（滤镜，T12）：**同一张表里**多一行 —— 滤镜也是这套
                    配方的一部分（"能带走的东西"只有一处，新起一块就把它拆成两处）。
                    存的是名字 + 强度；`amount` 是 0–100 的整数，直接跟一个 % 号。 */}
                {lut && (
                  <li>
                    <span className="recipe-param-name">Lut</span>
                    <span className="recipe-param-value">{lut.name} {lut.amount}%</span>
                  </li>
                )}
              </ul>
            )}
          <button className="recipe-apply" disabled={!canApply} onClick={() => onApply(params, lut)}>
            把这套调色套用到我正在改的图
          </button>
          {/* §3.7：告诉用户"不行"的地方，都要同时告诉他"那怎么办" */}
          {!canApply && <p className="recipe-hint">先回修图页传一张照片，才能套上去。</p>}
        </section>

        <section className="recipe-box">
          <h3>用 AI 做的</h3>
          <p className="recipe-note">这一栏属于这张照片，套不到别的图上</p>
          {edits.length === 0
            ? <p className="recipe-empty">这一张没有用过 AI。</p>
            : <ul className="recipe-edits">{edits.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          {/* ⚠️ 这里**故意一个按钮都没有**。给「套用」就是在骗人 ——
              「把后面那个人去掉」换一张照片就是另一回事（§3.5.1）。 */}
        </section>
      </div>
    </section>
  )
}
