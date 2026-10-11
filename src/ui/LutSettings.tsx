import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../api/client'
import { createLut, deleteLut, listLuts, lutUsage, renameLut } from '../api/luts.ts'
import {
  MAX_LUT_FILE_BYTES, MAX_LUTS, MAX_LUT_NAME, parseCube, type LutMeta,
} from '../../shared/lut.ts'
import { LUT_FILE_TOO_BIG, LUT_LIMIT_REACHED } from '../../shared/copy.ts'
import { formatSize } from './AccountPage.tsx'
import { Btn } from './kit/Btn.tsx'
import { Field, TextInput } from './kit/Field.tsx'
// ★ 2026-10-11（设计跟进 Task 2 / T5）：打不开时的标准件（居中一句 + 一颗能点的出口）。
import { ErrorState } from './kit/ErrorState.tsx'

/**
 * 设置里那一页「滤镜」（设计 §5.1）—— **导入 / 改名 / 删除 `.cube`**。
 *
 * 它是这个功能的**入口**：用户第一次拿到滤镜就是从这儿（微调区和对话区那两个格子里
 * 一颗都没有时，那句「还没有导入过滤镜。」下面就是一条通往这一页的路）。
 *
 * 骨架照 `ModelSettings.tsx`（同一层的东西不该长出两副面孔）：标题 + 一句说明 +
 * 一列窄内容。三条贯穿全页的规矩，动这一页之前先读一遍：
 *
 * ⚠️ **清单是四态的，不许拿空数组顶"还没拉到"**（`LutsState`，照
 *    `AdjustmentPanel` 那份 `WorksState` 的写法）。空数组顶上去的后果很具体：
 *    一个导了 20 个滤镜的人每次进这一页都会先看到一句「还没有导入过滤镜。」——
 *    和「0 张作品」是同一个毛病（《文案规范》§3：先问"这句话在什么情况下是假的？"）。
 *    拿不到（fail）同样**不许**说成"你没有"，只说服务端那句 + 下一步。
 *
 * ⚠️ **出错时显示的是服务端/解析器那句原话**（`ApiError.message` /
 *    `LutParseError.message`），不在这一层另写一套。同一个毛病在两处两种说法，
 *    用户会以为这是两件事（`shared/copy.ts` 那段注释是同一个道理）。
 *
 * ⚠️ **删之前先把代价说出来**（spec §6.4 用户拍板的那条语义）：那个 N 只有一个
 *    来源 —— `lutUsage(id)`。取不到就不给确认块（见 `askDelete`）。
 */
type LutsState =
  | { s: 'idle' }
  | { s: 'loading' }
  | { s: 'ready'; list: LutMeta[] }
  | { s: 'fail'; message: string }

/** 出错时那句人话的规矩在 `api/client.ts` 的 `errorText` 里（十来个文件共用一份）。 */

/**
 * 读一个文件的文本（`.cube` 是纯文本）。
 *
 * ⚠️ **不用 `file.text()`**：那是浏览器后来才有的 API，而我们跑测试的 jsdom
 *    （25 版）**没有它**（`Blob.prototype.text` / `arrayBuffer` 都是 undefined）——
 *    用它的话调用当场是一句 TypeError，屏幕上表现为"没导进来，再试一次"，
 *    而**真机上是好的**。`FileReader` 两边都有（浏览器里也不是废弃 API），
 *    多包一层 Promise 换来的是"这条路上测试量到的东西和真机是同一个"。
 */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '')
    fr.onerror = () => reject(fr.error ?? new Error('这个文件读不出来'))
    fr.readAsText(file)
  })
}

export function LutSettings({ onUse }: {
  /**
   * ★ 2026-10-05：「**怎么调用它**」那一步（用户：「我没看到怎么去调用 lut 文件」）。
   *
   * 导入只是把文件放进库里；真正"套在照片上"的地方在**调色那一屏的面板里**，
   * 而那一栏**默认是收着的** —— 所以这一颗不只是跳过去，落地时那一栏是**开着**的
   * （`defaultLutOpen`，接线在 `App.tsx`）。少了后半截，它只是把人送回一屏他刚
   * 才没找到东西的地方。
   */
  onUse: () => void
}) {
  const [load, setLoad] = useState<LutsState>({ s: 'idle' })
  /** 导入中（那颗按钮同时会变成「正在导入…」）。 */
  const [busy, setBusy] = useState(false)
  /** 页面上那一条出错的话（导入 / 删除）。改名那条住在它自己的表单里（`renameErr`）。 */
  const [err, setErr] = useState<string | null>(null)
  /** 就地展开的改名表单：哪一条、输入框里现在是什么。null = 没有展开的。 */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renamingBusy, setRenamingBusy] = useState(false)
  /** 删除的确认块：哪一条 + `lutUsage` 回的那条数（那句话里的 N）。null = 没开。 */
  const [ask, setAsk] = useState<{ id: number; sessions: number } | null>(null)
  /** 正在问"有谁在用"的那一条 —— 那一刻那颗「删除」按不动（别让人点两次）。 */
  const [checking, setChecking] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * 卸载之后晚到的响应不再写状态（`AccountPage` / `AdjustmentPanel` 同款理由）。
   *
   * ⚠️ **`alive.current = true` 那一行是必须的，别删**：StrictMode 在开发模式会把
   *    "挂载 → 卸载 → 再挂载"整个重放一遍 —— 第一次 cleanup 把它置成 false 之后，
   *    effect 会**第二次运行**；不拨回来的话它永远是 false，这一页就永远停在
   *    「正在打开…」（测试里 App 不走 StrictMode，全绿 —— 这正是"测试绿而真机死"
   *    那一类，只有真机探针能抓，见 `AdjustmentPanel` 里记的那次）。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * 拉一遍清单。
   *
   * ★ 已经有名单时**不退回 loading**（导入 / 改名 / 删完之后重拉用得着它）：
   *   列表闪一下"正在打开…"再回来，读起来像出了错。
   */
  const loadLuts = useCallback(async () => {
    setLoad((cur) => (cur.s === 'ready' ? cur : { s: 'loading' }))
    try {
      const { luts } = await listLuts()
      if (alive.current) setLoad({ s: 'ready', list: luts })
    } catch (e) {
      // ⚠️ 失败时**绝不画成空清单**（见文件头那段）：说服务端那句话 + 下一步。
      if (alive.current) setLoad({ s: 'fail', message: errorText(e,'打不开 Lut 清单') })
    }
  }, [])

  useEffect(() => { void loadLuts() }, [loadLuts])

  /** 现在满了吗（满 30 个就不给导入了）。清单没到手时**不拦** —— 上限由服务端兜底。 */
  const full = load.s === 'ready' && load.list.length >= MAX_LUTS

  /**
   * 导入一个文件。
   *
   * 三道闸**按顺序**：太大 → 本地解一遍 → 服务端。前两道是**体验**（当场说话，
   * 省掉一趟注定被拒的往返），第三道才是权威（服务端会拿同一份解析器再解一遍，
   * 而且名字冲突、条数、空间这些只有它知道）。
   */
  const importFrom = async (file: File) => {
    if (busy) return
    setErr(null)
    // ① 太大：连读都不读。这句和 `server/luts.ts` 用的是**同一个常量**
    //    （`shared/copy.ts` 的 `LUT_FILE_TOO_BIG`，spec §6.3 冻死的那句）——
    //    两边各写一份的那天，用户会对同一个毛病看到两种说法。
    if (file.size > MAX_LUT_FILE_BYTES) { setErr(LUT_FILE_TOO_BIG(MAX_LUT_FILE_BYTES)); return }

    setBusy(true)
    try {
      const text = await readText(file)
      // ② 本地先解一遍：**即时反馈**（坏文件当场说话，不用等一个来回）
      const cube = parseCube(text)
      // 名字：`.cube` 里的 TITLE 优先，没有就用文件名去扩展名 ——
      // 和服务端那条兜底（`o.name` → `cube.title` → 「未命名」）是同一个次序。
      const name = cube.title ?? file.name.replace(/\.[^.]*$/, '')
      // ③ 权威那一道。名字和**原文**一起送（服务端要自己再解一遍，别送 base64）。
      await createLut(name, text)
      // 成功不弹窗：列表里直接多一行（§5.1）。重拉而不是自己往名单里塞一条 ——
      // 服务端可能会改名字（截断 / 去空格），名单的真值只有它那一份。
      await loadLuts()
    } catch (e) {
      setErr(errorText(e,'没导进来，再试一次'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const startRename = (l: LutMeta) => {
    setErr(null)
    setAsk(null)
    setRenameErr(null)
    setRenaming({ id: l.id, value: l.name })
  }

  const doRename = async () => {
    if (!renaming || renamingBusy) return
    setRenameErr(null)
    setRenamingBusy(true)
    try {
      await renameLut(renaming.id, renaming.value.trim())
      setRenaming(null)
      await loadLuts()
    } catch (e) {
      setRenameErr(errorText(e,'没改成，再试一次'))
    } finally {
      if (alive.current) setRenamingBusy(false)
    }
  }

  /**
   * 打开删除确认 —— **先问一次有谁在用**。
   *
   * ⚠️ 问不到就**不给确认块**：那句"还有 N 条老会话在用"里 N 的唯一来源就是这一次
   *    询问，拿不到就只剩一句"删了就找不回来了"，而那可能是一句假话（正好有 3 条
   *    会话在用）。宁可说一句"没问出来，再试一次"，也不让用户闭着眼睛删。
   */
  const askDelete = async (l: LutMeta) => {
    if (checking !== null) return
    setErr(null)
    setRenaming(null)
    setAsk(null)
    setChecking(l.id)
    try {
      const { sessions } = await lutUsage(l.id)
      if (alive.current) setAsk({ id: l.id, sessions })
    } catch (e) {
      setErr(errorText(e,'没问出这个 Lut 有没有在用，再试一次'))
    } finally {
      if (alive.current) setChecking(null)
    }
  }

  const doDelete = async () => {
    if (!ask || deleting) return
    setErr(null)
    setDeleting(true)
    try {
      await deleteLut(ask.id)
      setAsk(null)
      await loadLuts()
    } catch (e) {
      setErr(errorText(e,'没删掉，再试一次'))
    } finally {
      if (alive.current) setDeleting(false)
    }
  }

  return (
    <section className="luts">
      <h1 className="luts-title">Lut</h1>
      {/* 顶上说明一句：这一页是干嘛的、导入之后在哪儿用得上。
          ⚠️ 不吹"多少款滤镜"这类做不到的话 —— 内容全是用户自己导进来的。
          ⚠️ 两个宿主叫「调色」和「对话」：界面上的名字只有这两个（曾经的
          「微调区」是 09-30 改名前的老叫法，同一个能力不许两个叫法）。 */}
      <p className="luts-lede">导入 .cube，套在照片上改颜色。调色和对话里都能用。</p>

      <div className="luts-actions">
        {/* 藏起来的文件输入框由这颗按钮去点它（`.luts-file` 是 display:none，
            和上传那一屏那颗「选照片」同一个做法，见 `Uploader.tsx`）。
            满 30 个时按不动 —— 而且旁边把事情说清楚（只禁按钮不说话，
            用户只会以为按钮坏了）。 */}
        <Btn className="luts-import" disabled={busy || full}
             onClick={() => fileRef.current?.click()}>
          {busy ? '正在导入…' : '导入 .cube'}
        </Btn>
        <input
          ref={fileRef}
          className="luts-file"
          type="file"
          accept=".cube"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // ⚠️ 清掉 input 的值：同一个文件**再选一次**时浏览器认为"没变"、
            //    change 不会再来 —— 用户会以为按钮坏了（第二次点什么都没发生）。
            //    File 对象已经拿到了，清值不影响它。
            e.target.value = ''
            if (file) void importFrom(file)
          }}
        />
        {full && <span className="luts-hint">{LUT_LIMIT_REACHED(MAX_LUTS)}</span>}

        {/* ★ 2026-10-05：**"怎么调用它"那条路**（用户原话：「我没看到怎么去调用
            lut 文件」）。它就摆在「导入 .cube」旁边 —— 这一页的两件事从此一眼看全：
            往里放 / 拿出去用。
            ⚠️ 只在**真有滤镜**时出现：一个都没有时它把人送到一个空 picker 前面，
            而那时候该做的事明明是先导一个（下面那句「还没有导入过滤镜。」管这个）。
            ⚠️ 它是**次要动作**：不穿主按钮那身（`.luts-import` 才是这一页的主按钮），
            走全站那颗普通按钮的长相。 */}
        {load.s === 'ready' && load.list.length > 0 && (
          <button type="button" className="luts-go-use" onClick={onUse}>去调色里套一张</button>
        )}
      </div>

      {err && <p className="luts-error">{err}</p>}

      {/* 四态里"还没到手"的那两态：一句在路上的话。**不许**在这里画空清单。 */}
      {(load.s === 'idle' || load.s === 'loading') && <p className="luts-hint">正在打开…</p>}
      {load.s === 'fail' && (
        /* ★ 2026-10-11（设计跟进 T5）：和作品 / 对话 / 详情 / 模型设置四处
           **同一副样子** —— 居中一句 + 一颗真的重跑这一趟的「再试一次」
           （`ui/kit/ErrorState`）。§3.7 那条没变：说了"不行"就得给"那怎么办"。
           换掉的那句是「刷新一下页面，再试一次。」—— 整页刷新会把他这一屏
           之外的活儿一起冲掉，而重跑这一趟就够了。 */
        <ErrorState text={load.message} onRetry={() => void loadLuts()} />
      )}
      {load.s === 'ready' && load.list.length === 0 && (
        // 这句只在**真的拉到了空清单**之后才说（见文件头那段）
        <p className="luts-empty">还没有导入过 Lut。</p>
      )}

      {load.s === 'ready' && load.list.length > 0 && (
        // 卡和行都走「个人设置」那张卡的长相（`.account-card` / `.account-row`）——
        // 同一层里的两页长得像一家，而不是各自发明一套列表。
        <div className="account-card luts-list">
          {load.list.map((l) => (
            <div className="luts-item" key={l.id}>
              <div className="account-row luts-row">
                <span className="luts-name">{l.name}</span>
                {/* 「33 级 · 240 KB」——这一行的注解，不是主句（和 `.account-row-value` 同一条） */}
                <span className="luts-meta">{l.size} 级 · {formatSize(l.bytes)}</span>
                <button type="button" onClick={() => startRename(l)}>改名</button>
                <button type="button" onClick={() => void askDelete(l)}
                        disabled={checking !== null}>
                  {checking === l.id ? '正在看…' : '删除'}
                </button>
              </div>

              {/* 改名：就地展开（照「个人设置」里改密码那一段的形状）——
                  不弹浮层：这一层没有弹窗文化，浮层还多一层"怎么关"的焦虑。 */}
              {renaming?.id === l.id && (
                <form className="luts-expand luts-rename"
                      onSubmit={(e) => { e.preventDefault(); void doRename() }}>
                  <Field className="luts-field" label="新名字">
                    {/* `maxLength`：名字上限是 30（服务端超了会**默默截断**，
                        用户会以为自己存进去的是原来那个长名字）—— 在这一格先拦住。 */}
                    <TextInput name="lutName" value={renaming.value} autoComplete="off"
                               maxLength={MAX_LUT_NAME}
                               onChange={(e) => setRenaming({ id: l.id, value: e.target.value })} />
                  </Field>
                  {renameErr && <p className="luts-error">{renameErr}</p>}
                  <div className="luts-expand-actions">
                    <Btn type="submit" disabled={renamingBusy || renaming.value.trim() === ''}>
                      {renamingBusy ? '正在改…' : '改名'}
                    </Btn>
                    <button type="button" onClick={() => { setRenaming(null); setRenameErr(null) }}>
                      取消
                    </button>
                  </div>
                </form>
              )}

              {/* 删除的确认块（§6.4）。**这句话里的 N 是 `lutUsage` 回的**，
                  分成两句是因为代价本来就是两种：有人用（老会话再打开会变样）
                  和没人用（只是找不回来了）。 */}
              {ask?.id === l.id && (
                <div className="luts-expand luts-ask">
                  <p>
                    {ask.sessions > 0
                      ? `还有 ${ask.sessions} 条老会话在用这个 Lut。删了之后，它们再打开会变回没有 Lut 的样子。`
                      : '删了就找不回来了。'}
                  </p>
                  <div className="luts-expand-actions">
                    {/* ⚠️ 危险动作那颗穿**危险色**（`.luts-delete`，和「确认注销」共用一份
                        长相），而且**排在那句代价后面** —— 先看完"会失去什么"才够得着它。 */}
                    <Btn className="luts-delete" disabled={deleting} onClick={() => void doDelete()}>
                      {deleting ? '正在删…' : '确认删除'}
                    </Btn>
                    <button type="button" onClick={() => setAsk(null)}>先不删</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
