import { useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { errorText } from '../api/client'
import { MAX_PRESETS, MAX_PRESET_NAME, type PresetMeta } from '../../shared/preset.ts'
import { PRESET_LIMIT_REACHED } from '../../shared/copy.ts'
import type { Adjustments } from '../../shared/adjustments.ts'
import { Btn } from './kit/Btn.tsx'
import { RenameInput } from './kit/RenameInput.tsx'

/**
 * ★ 2026-10-10（「我的预设」，设计 §5.1）：调色面板头那颗「我的预设」
 * **就地展开**出来的那一块 —— 存 / 改名 / 删。
 *
 * 和 `LutSettings` 是两副面孔、一套骨架（那边整页、这边一栏），三条规矩一样：
 *
 * ⚠️ **清单是四态的，不许拿空数组顶"还没拉到"**（`known`，来源是
 *    `app/usePresets`）。一个存过 20 套的人每次点开都会先看到一句
 *    「还没有存过预设。」—— 和「0 张作品」是同一个毛病（《文案规范》§3：
 *    先问"这句话在什么情况下是假的？"）。拿不到（fail）同样**不许**说成"你没有"。
 *
 * ⚠️ **出错时显示的是服务端那句原话**（`ApiError.message`，经 `errorText` 翻），
 *    不在这一层另写一套。同名那类错只有服务端说得清（它知道库里有什么）。
 *
 * ⚠️ **存/改名/删之后的名单维护全在 App 那三个回调里**（成功之后重拉，照
 *    `LutSettings` 三处同一做法）—— 这一层**从不往名单里塞/改/抠**，`presets`
 *    是只读的当前真值。删除是**就地确认**、不弹窗（全站规矩；这一屏尤其没有——
 *    「调色就是对图片微调的界面区」，见 `AdjustmentPanel` 里那段）。
 */
export function PresetManager({ presets, known, params, onSave, onRename, onDelete }: {
  /** 当前清单（真值在服务端，这里只是它最近一次的影子）。 */
  presets: readonly PresetMeta[]
  /** 清单**到手了没有**（看 `usePresets` 那段 —— 它和"空"是两件事）。 */
  known: boolean
  /** 存的就是**当下这套参数**（面板上此刻的样子，不是差量）。 */
  params: Adjustments
  /** 存一套。成功之后 App 会重拉清单 —— 这一层只负责清输入框。 */
  onSave: (name: string, params: Adjustments) => Promise<void>
  onRename: (id: number, name: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
}) {
  /** 起名那一格现在写着什么。**成功才清空**（失败保留 —— 别让人重打一遍）。 */
  const [name, setName] = useState('')
  /** 存的一套**在路上**（那颗按钮同时会变成「正在存…」）。 */
  const [busy, setBusy] = useState(false)
  /** 这一栏上出错的那句话（存 / 改名 / 删共用一条 —— 同时只有一件事在发生）。 */
  const [err, setErr] = useState<string | null>(null)
  /** 就地改名的是哪一条（null = 没在改）。 */
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 删除的确认块开在哪一条下面（null = 没开）。开了**什么都还没删**。 */
  const [ask, setAsk] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  /**
   * 卸载之后晚到的响应不再写状态（`AccountPage` / `LutSettings` 同款理由）。
   *
   * ⚠️ **`alive.current = true` 那一行是必须的，别删**：StrictMode 在开发模式会把
   *    "挂载 → 卸载 → 再挂载"整个重放一遍 —— 第一次 cleanup 把它置成 false 之后，
   *    effect 会**第二次运行**；不拨回来的话它永远是 false（测试里 App 不走
   *    StrictMode，全绿 —— 这正是"测试绿而真机死"那一类）。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /** 满了吗（满 30 套就不给再存了）。清单没到手时**不拦** —— 上限由服务端兜底。 */
  const full = presets.length >= MAX_PRESETS

  const doSave = async () => {
    if (busy || full) return
    const trimmed = name.trim()
    // 空名字这颗按钮本来就是禁用的；这里再挡一次是防"回车提交"那条路。
    if (trimmed === '') return
    setErr(null)
    setBusy(true)
    try {
      // 名字 trim 过再送（服务端也会 trim，两边同一条 —— 判重名认的就是 trim 后的）。
      await onSave(trimmed, params)
      // 成功清空输入框（失败**不**清，见 `name` 那段）—— 接着存第二套不用先删字。
      if (alive.current) setName('')
    } catch (e) {
      if (alive.current) setErr(errorText(e, '没存下来，再试一次'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  /**
   * 回车 / 点走之后交回来的新名字。两个"当场收工"的口子：
   *   · 空着提交 = 回退（`RenameInput` 的规矩："预填显示名、清空 = 不改"）；
   *   · 没改也收工 —— 白跑一趟 PATCH 没有意义。
   */
  const commitRename = async (p: PresetMeta, raw: string) => {
    const next = raw.trim()
    if (next === '' || next === p.name) return
    setErr(null)
    try {
      await onRename(p.id, next)
    } catch (e) {
      if (alive.current) setErr(errorText(e, '没改成，再试一次'))
    }
  }

  const doDelete = async (id: number) => {
    if (deleting) return
    setErr(null)
    setDeleting(true)
    try {
      await onDelete(id)
      if (alive.current) setAsk(null)
    } catch (e) {
      if (alive.current) setErr(errorText(e, '没删掉，再试一次'))
    } finally {
      if (alive.current) setDeleting(false)
    }
  }

  return (
    <div className="my-presets">
      {/* 起名 + 存。做成 `<form>`：回车 = 提交（和起名那一格别的输入框同一条手势）。 */}
      <form className="my-presets-save"
            onSubmit={(e) => { e.preventDefault(); void doSave() }}>
        <input
          className="my-presets-name"
          value={name}
          placeholder="给这套起个名…"
          autoComplete="off"
          // 名字上限 30（R5：只判不截断 —— 这里先拦住，超了服务端也会 400 拒，
          // 但**不 slice**：手打的名字不许被静默改掉一截）。
          maxLength={MAX_PRESET_NAME}
          disabled={full}
          onChange={(e) => setName(e.target.value)}
        />
        {/* 名字空着 / 满额 / 正在存 —— 三种都按不动。
            ⚠️ 只禁按钮不说话 = 用户以为按钮坏了：满额那句就摆在旁边（见下）。 */}
        <Btn type="submit" disabled={busy || full || name.trim() === ''}>
          {busy ? '正在存…' : '存下来'}
        </Btn>
      </form>
      {full && <p className="luts-hint">{PRESET_LIMIT_REACHED(MAX_PRESETS)}</p>}
      {err && <p className="luts-error">{err}</p>}

      {/* 四态里"还没到手"那一态：一句在路上的话。**不许**在这里画空清单。 */}
      {!known && <p className="luts-hint">预设清单还没到手，正在取…</p>}
      {known && presets.length === 0 && (
        // 这句只在**真的拉到了空清单**之后才说（见文件头那段）。
        <p className="luts-empty">还没有存过预设。</p>
      )}

      {known && presets.length > 0 && (
        <div className="my-presets-list">
          {presets.map((p) => (
            <div className="my-presets-item" key={p.id}>
              <div className="my-presets-row">
                {renaming === p.id ? (
                  // 改名：就地变输入框（`kit/RenameInput` —— 作品详情 / 对话列表 /
                  // 对话栏顶上那三处同一份手势：回车/点走保存、Esc/✕ 取消）。
                  <RenameInput
                    className="my-presets-rename"
                    defaultValue={p.name}
                    maxLength={MAX_PRESET_NAME}
                    ariaLabel="预设名字"
                    onCommit={(v) => { setRenaming(null); void commitRename(p, v) }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <>
                    <span className="my-presets-label">{p.name}</span>
                    {/* 两颗都是**图标键**（屏幕上没有字）：名字只在 `aria-label`
                        （和对话栏那颗铅笔同一条规矩），图标 `aria-hidden` 不进
                        textContent —— "按文字找按钮"的地方不会认错。 */}
                    <button type="button" aria-label="改名"
                            onClick={() => { setErr(null); setAsk(null); setRenaming(p.id) }}>
                      <Pencil size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                    {/* ⚠️ 打开确认块**不动** `renaming`？—— 要清掉：两颗按钮是
                        "二选一"的关系，改名输入框开着时点删除，不收起输入框的话
                        这一行会一边编辑一边问删不删。 */}
                    <button type="button" aria-label="删除"
                            onClick={() => { setErr(null); setRenaming(null); setAsk(p.id) }}>
                      <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>

              {/* 删除的确认块（§5.1）：**在那一行下面**就地摊开。
                  预设和会话没有绑定关系（不像 Lut 有"还有 N 条在用"），所以只有
                  "找不回来"这一半 —— 一句话就够。 */}
              {ask === p.id && (
                <div className="luts-expand luts-ask">
                  <p>删了就找不回来了。</p>
                  <div className="luts-expand-actions">
                    {/* ⚠️ 危险动作那颗穿**危险色**（`.luts-delete`，和「确认注销」/
                        Lut 删除共用一份长相），而且**排在那句代价后面**。 */}
                    <Btn className="luts-delete" disabled={deleting}
                         onClick={() => void doDelete(p.id)}>
                      {deleting ? '正在删…' : '确认删除'}
                    </Btn>
                    <button type="button" onClick={() => setAsk(null)}>算了</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
