import { useEffect, useMemo, useState } from 'react'
import { getWork, renameWork, deleteWork, fileUrl } from '../api/works'
import { workName, type WorkDetail } from '../../shared/works.ts'
import { PARAM_LABELS, PARAM_KEYS, type Adjustments } from '../../shared/adjustments.ts'

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
  onApply: (params: Adjustments) => void
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
  const { params, edits } = work.recipe

  return (
    <section className="detail">
      <header className="detail-head">
        <button className="detail-back" onClick={onBack}>← 作品</button>
        {renaming ? (
          <input className="rename-input" autoFocus defaultValue={work.alias ?? ''}
                 onBlur={e => void doRename(e.target.value)}
                 onKeyDown={e => {
                   if (e.key === 'Enter') void doRename((e.target as HTMLInputElement).value)
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

      <img className="detail-image" src={fileUrl(work)} alt={name} />

      <div className="detail-actions">
        {/* 下载就是把这个文件给他 —— 和存在服务器上的**是同一份**（裁定 ①） */}
        <a className="detail-download" href={fileUrl(work)} download>下载到我的电脑</a>
        {confirming ? (
          <span className="detail-confirm">
            <span>删掉作品集里的这一份吗？删了就找不回来了。</span>
            <button onClick={() => void doDelete()} disabled={busy}>删掉</button>
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
          <ul className="recipe-params">
            {PARAM_KEYS.map(k => (
              <li key={k}>
                <span className="recipe-param-name">{PARAM_LABELS[k]}</span>
                <span className="recipe-param-value">
                  {/* 0 就不列了 —— 一排 0 只是噪音，用户要的是"改过什么" */}
                  {params[k] === 0 ? '—' : (params[k] > 0 ? `+${params[k]}` : String(params[k]))}
                </span>
              </li>
            ))}
          </ul>
          <button className="recipe-apply" disabled={!canApply} onClick={() => onApply(params)}>
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
