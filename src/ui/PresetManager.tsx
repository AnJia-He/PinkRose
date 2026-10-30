import { useEffect, useRef, useState } from 'react'
import { Download, Pencil, Trash2, Upload } from 'lucide-react'
import { errorText } from '../api/client'
import {
  MAX_PRESETS, MAX_PRESET_NAME, samePresetName, type PresetMeta,
} from '../../shared/preset.ts'
import { PRESET_LIMIT_REACHED } from '../../shared/copy.ts'
import type { Adjustments } from '../../shared/adjustments.ts'
import {
  parsePresetFile, parsePresetXmp, presetExportFilename, presetXmpFilename,
  serializePresetXmp, serializePresets,
} from '../core/presetFile'
import { downloadFile } from '../export/save'
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
 *
 * ★ 2026-10-10（设计 §5.4）：**第一行（起名 + 存）抽给了 `PresetSaveRow`**
 *   （文件底下那段）—— 作品详情页配方卡上那颗「把这套存成预设」展开的就是它，
 *   两处共用一份。这里只剩清单 / 改名 / 删。
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
  /** 这一栏上出错的那句话（**改名 / 删**共用一条 —— 同时只有一件事在发生）。
   *  ⚠️ "存"那条错**不在这里**：起名那一行连它的状态一起搬去了 `PresetSaveRow`
   *  （文件底下那段 —— 面板头和作品详情页共用同一份），那一行说自己的事。 */
  const [err, setErr] = useState<string | null>(null)
  /** 就地改名的是哪一条（null = 没在改）。 */
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 删除的确认块开在哪一条下面（null = 没开）。开了**什么都还没删**。 */
  const [ask, setAsk] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [transferMsg, setTransferMsg] = useState<string | null>(null)
  const [transferErr, setTransferErr] = useState<string | null>(null)
  const presetFileRef = useRef<HTMLInputElement | null>(null)

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

  const doExport = () => {
    if (presets.length === 0) return
    setTransferErr(null)
    const blob = new Blob([serializePresets(presets)], { type: 'application/json' })
    downloadFile(blob, presetExportFilename())
    setTransferMsg(`已导出 ${presets.length} 套。`)
  }

  const doExportXmp = () => {
    setTransferErr(null)
    const blob = new Blob(
      [serializePresetXmp('PinkRose 当前调色', params)],
      { type: 'application/rdf+xml' },
    )
    downloadFile(blob, presetXmpFilename())
    setTransferMsg('已导出当前调色的 XMP。')
  }

  const doImport = async (file: File) => {
    if (importing) return
    setTransferErr(null)
    setTransferMsg(null)
    if (!known) {
      setTransferErr('预设清单还没到手，等一下再导入。')
      return
    }
    setImporting(true)
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('这个预设文件读不出来。'))
        reader.readAsText(file)
      })
      const isXmp = /\.xmp$/i.test(file.name)
        || file.type.includes('rdf')
        || /<x:xmpmeta[\s>]/.test(text)
      const list = isXmp
        ? [parsePresetXmp(text, file.name)]
        : parsePresetFile(text)
      const room = MAX_PRESETS - presets.length
      if (list.length > room) {
        throw new Error(`现在最多还能导入 ${Math.max(0, room)} 套，先删掉几套再来。`)
      }
      const conflict = list.find(item => presets.some(p => samePresetName(p.name, item.name)))
      if (conflict) {
        throw new Error(`已经有一套叫「${conflict.name}」的预设了，先删掉或改名再导入。`)
      }
      let imported = 0
      for (const item of list) {
        try {
          await onSave(item.name, item.params)
          imported++
        } catch (e) {
          if (alive.current) {
            setTransferErr(
              `已导入 ${imported} 套，「${item.name}」没存进去：${errorText(e, '再试一次')}`,
            )
          }
          return
        }
      }
      if (alive.current) setTransferMsg(`已导入 ${imported} 套。`)
    } catch (e) {
      if (alive.current) setTransferErr(presetTransferError(e, '这个预设文件没读成。'))
    } finally {
      if (alive.current) setImporting(false)
    }
  }

  return (
    <div className="my-presets">
      {/* 起名 + 存 —— 这一行住在 `PresetSaveRow` 里（文件底下那段）：面板头和
          **作品详情页**那两张脸共用**同一份**（设计 §5.4 要的"复用存组件"）。 */}
      <PresetSaveRow params={params} full={full} onSave={onSave} />
      <div className="my-presets-transfer">
        <input
          ref={presetFileRef}
          className="my-presets-file"
          type="file"
          accept="application/json,.json,application/rdf+xml,.xmp,application/xml,text/xml"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void doImport(file)
            e.target.value = ''
          }}
        />
        <button type="button" disabled={importing || !known}
                onClick={() => presetFileRef.current?.click()}>
          <Upload size={14} strokeWidth={1.5} aria-hidden="true" />
          {importing ? '正在导入…' : '导入预设'}
        </button>
        <button type="button" disabled={importing || presets.length === 0}
                onClick={doExport}>
          <Download size={14} strokeWidth={1.5} aria-hidden="true" />
          导出全部
        </button>
        <button type="button" disabled={importing} onClick={doExportXmp}>
          <Download size={14} strokeWidth={1.5} aria-hidden="true" />
          导出当前 XMP
        </button>
        <span>JSON 含全部预设；XMP 单套，不含 Lut</span>
      </div>
      {transferMsg && <p className="luts-hint">{transferMsg}</p>}
      {transferErr && <p className="luts-error">{transferErr}</p>}
      {/* **改名 / 删**那条错（存那条在 `PresetSaveRow` 里自己说）—— 位置和
          原来一样：在这一栏那一堆清单话的上面。 */}
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

/**
 * 起名 + 存**那一行** —— ★ 2026-10-10（「我的预设」，设计 §5.4）从上面那个组件里
 * 抽出来的：**两个存入口共用这一份**（调色面板头那块的第一行 / 作品详情页配方卡上
 * 「把这套存成预设」展开的那一行）。
 *
 * 为什么是"抽这一段"而不是"整体复用 `PresetManager`"：§5.4 只要"一行
 * 「[起名][存下来]」"，而 `PresetManager` 会把清单、改名、删除一整套一起端上来。
 * 反过来抄第二份的话，"成功清输入框 / 失败保留刚打的字 / 出错说服务端那句原话"
 * 这些账只会记在一边 —— 下一次改只会改到一半（这正是"同一段代码被重复利用"
 * 那条去重规矩要防的）。
 *
 * ⚠️ `full`（满 30 套那一档）是**选填**的：作品详情页那侧手上没有清单可数
 *    （清单是 `usePresets` 的），所以它不传 —— 真满了服务端会用**同一句话**
 *    （`PRESET_LIMIT_REACHED`）拒掉，原话就摆在那一行下面。
 *    不为那一档把清单从 App 一路拽到详情页。
 */
export function PresetSaveRow({ params, full = false, onSave }: {
  /** 存的就是**这套参数** —— 面板上此刻那套 / 那张作品的配方（调用方说了算）。 */
  params: Adjustments
  /** 满 30 套了吗？（不传 = 不拦 —— 上限由服务端兜底） */
  full?: boolean
  /** 存一套。成功之后 App 会重拉清单 —— 这一层只负责清输入框。 */
  onSave: (name: string, params: Adjustments) => Promise<void>
}) {
  /** 起名那一格现在写着什么。**成功才清空**（失败保留 —— 别让人重打一遍）。 */
  const [name, setName] = useState('')
  /** 存的一套**在路上**（那颗按钮同时会变成「正在存…」）。 */
  const [busy, setBusy] = useState(false)
  /** 这一行上出错的那句话（就在这一行下面显示 —— 不弹窗）。 */
  const [err, setErr] = useState<string | null>(null)

  /** 卸载之后晚到的响应不再写状态（`AccountPage` / `LutSettings` 同款理由；
   *  ⚠️ `alive.current = true` 那一行是必须的，别删 —— StrictMode 会重放
   *  "挂载 → 卸载 → 再挂载"，见 `PresetManager` 里那段）。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

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

  return (
    <>
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
    </>
  )
}

/** 导入这一层的错误：我们自己抛的是人话，网络层错误交给 `errorText`。 */
function presetTransferError(e: unknown, fallback: string): string {
  if (e instanceof Error && /[\u3400-\u9fff]/.test(e.message)) return e.message
  return errorText(e, fallback)
}
