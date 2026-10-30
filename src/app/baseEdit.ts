/**
 * 「在**当前这一版**的底图上动一刀」的共享骨架 —— 裁剪（`commitCrop`）和
 * 点修（`commitRetouch`）两条路都走它。
 *
 * ★ 2026-10-08 从 `App.tsx` 里收出来的：这两个"提交"原本各自抄了一遍同样的
 *   骨架（那边的注释自己写着「和 `commitCrop` **一字不差**的那几条」）。
 *   这套骨架里每一步都是踩出来的坑，抄两遍就是"改一处、忘一处"的温床 ——
 *   而每一处漏掉都是**静默**的（画面照变，账本 / 落盘悄悄错）。
 *
 * 三段，按时间顺序：
 *   · `beginBaseEdit` —— `await` **之前**当场读两个记号（这一下冲着哪一版去的）；
 *   · `discardStaleBaseEdit` —— `await` 回来先对两样，对不上就作废（close + 报）；
 *   · `applyBaseEdit` —— 定稿 + 记一笔账 + 换底图 + 清那批临时状态。
 * 三段之间隔着调用方的像素活儿（`cropToBitmap` / `eraseToBitmap`），
 * 所以它们是三个函数、不是一个。
 */
import type { Dispatch, SetStateAction } from 'react'
import type { DecodedImage } from '../image/decode'
import type { Snapshot } from '../core/history'
import type { EditLayer } from '../../shared/layers.ts'
import type { ToolId } from '../ui/ToolBar'
import { pushEdit, settleLedger, type EditState } from '../core/ledger'

/** `beginBaseEdit` 的产物 —— 「这一下冲着哪一版去的」两个记号。 */
export type BaseEditGate = { seqAt: number; at: number | null }

/**
 * 裁剪（`useCrop`）/ 点修（`useRetouch`）两个 hook 的入参 —— **同一张单子**。
 *
 * ★ 2026-10-09：这两个文件头原来各抄了一份 13 项的 `CropDeps` / `RetouchDeps`，
 *   一字不差（连"当前开着哪个工具"那条注释都只差一个词）。抄两份的代价和这套
 *   骨架本身一样 —— 加一项就得记得改两处：**漏一边编译器会拦**（还算好），
 *   真正危险的是两边**一起漂**（一处改了语意、另一处照旧），那就没人拦了。
 */
export type BaseEditToolDeps = {
  /** 当前开着哪个工具（现场只在"自己那个工具"开着时交出去）。 */
  tool: ToolId | null
  image: DecodedImage | null
  setImage: Dispatch<SetStateAction<DecodedImage | null>>
  history: readonly Snapshot[]
  setHistory: Dispatch<SetStateAction<Snapshot[]>>
  noticeBad: (text: string) => void
  /** 定稿那一笔没落定的调色（`app/usePersist` 的 `flushEdit`）。 */
  flushEdit: () => void
  /** 换底图时那批"临时状态"一起清（`App` 的 `clearTransient`）。 */
  clearTransient: () => void
  baseSeqRef: { current: number }
  cursorIdRef: { current: number | null }
  editSeqRef: { current: number }
  markDirty: (stepId: number, baseChanged: boolean, layersChanged?: boolean) => void
  setTool: (t: ToolId | null) => void
}

/**
 * `await` 之前**当场读**两个记号：底图版本（`baseSeqRef`）+ 站的位置（`cursorIdRef`）。
 *
 * ⚠️ **必须在 `await` 之前读**（评审 Important ②）—— 这不是洁癖，是 `setHistory`
 *   的 updater **不保证当场跑**：等待像素活儿那几十~几百毫秒里，只要同一批里
 *   还有别的 setState（卡片的应答 / 某个计时器 / 别处的一次 setState 任意一个
 *   落下来），updater 就推到**渲染时**才跑 —— 那时候现读 `cursorIdRef.current`
 *   可能已经不是出发时那一版了。
 *   和 `useGeneration` 的 `origin` 显式入参是同一条规矩：隔着 await 的地方，
 *   位置一律**当场读、传值**。
 */
export function beginBaseEdit(
  baseSeqRef: { current: number },
  cursorIdRef: { current: number | null },
): BaseEditGate {
  return { seqAt: baseSeqRef.current, at: cursorIdRef.current }
}

/**
 * `await` 回来先对**两样**：底图版本 + 站的位置 —— 对不上就说明这段等待里画面
 * 变了（生成落地 / 切走 / 换了张照片 / 人跳了版本）。这一下要么是从一张**已经
 * 不在屏上的**底图上做出来的，要么会被记到**别人那一版**上（光标指着 A、画面
 * 却是 B 做出来的样子），写进去都是静默事故。
 *
 * 作废 = 把刚做出来的那张位图还回去 + 留一条 console + 对用户说一句，返回 `true`；
 * 调用方接着收自己的现场（裁剪收框、点修收掩码）然后走人。
 * 对得上返回 `false`，调用方继续 `applyBaseEdit`。
 *
 * `why.log` / `why.notice` 是各调用点自己那两句话（"这一刀" / "这一擦"）。
 */
export function discardStaleBaseEdit(
  baseSeqRef: { current: number },
  cursorIdRef: { current: number | null },
  gate: BaseEditGate,
  bitmap: { close(): void },
  why: { log: string; notice: string },
  noticeBad: (text: string) => void,
): boolean {
  if (baseSeqRef.current === gate.seqAt && cursorIdRef.current === gate.at) return false
  bitmap.close()
  console.error(why.log)
  noticeBad(why.notice)
  return true
}

/** `applyBaseEdit` 的接线（`at` / `base` 由调用点现给，其余是 App 那一层的家伙什）。 */
export type BaseEditCommit = {
  /** 这一笔记在**哪一版**上 —— `beginBaseEdit` 的 `at`，原样传进来。 */
  at: number | null
  /** 像素活儿的产物。 */
  bitmap: ImageBitmap
  /** 这一笔之后文字层变成什么；不给 = 原样保留。几何工具用它清空（字已合并）。 */
  layers?: EditLayer[]
  /** 和 `layers` 配套：把 App 上的文字层状态一起换掉。 */
  setLayers?: Dispatch<SetStateAction<EditLayer[]>>
  /**
   * 调用方**闭包里的** `history` —— 和 `at` 是同一拍读的。
   * ⚠️ 不能现读：下面那句"那一版还在不在"的检查必须和 `at` 对齐。
   */
  history: readonly Snapshot[]
  setHistory: Dispatch<SetStateAction<Snapshot[]>>
  setImage: Dispatch<SetStateAction<DecodedImage | null>>
  baseSeqRef: { current: number }
  editSeqRef: { current: number }
  markDirty: (stepId: number, baseChanged: boolean, layersChanged?: boolean) => void
  flushEdit: () => void
  clearTransient: () => void
}

/**
 * 账本历史里显示的操作名。
 *
 * `what` 是各调用点本来就有的短句（“这一刀”“这一磨”），直接展示也能读，
 * 但历史列表里更适合用名词；认不出来时原样返回，**绝不吞掉**一个未来的新工具。
 */
const EDIT_LABELS: Record<string, string> = {
  '这一刀': '裁剪',
  '这一擦': '点修',
  '这一磨': '磨皮',
  '这一句': '文字',
  '这张贴纸': '贴纸',
  '这个形状': '形状',
  '这个边框': '边框',
  '这个画布': '画布',
  '这一叠': '双重曝光',
  '这一笔涂鸦': '涂鸦',
  '这个光效': '光效',
  '这个双色调': '双色调',
  '这一推': '液化',
  '这一局部': '局部调整',
  '这个人像': '人像',
  '这一克隆': '克隆',
  '这一抠': '抠图',
  '这一透视': '透视',
}

export function editLabelFor(what: string): string {
  return EDIT_LABELS[what] ?? what
}

/**
 * 定稿 + 记账 + 换底图 + 清临时状态 —— 裁剪 / 点修成功回来之后的那一段。
 * `what` 只进那句"账本没记上"的 console（`'这一刀'` / `'这一擦'`）。
 */
export function applyBaseEdit(deps: BaseEditCommit, what: string): void {
  const {
    at, bitmap, layers, setLayers, history, setHistory, setImage,
    baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
  } = deps
  const base: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height }
  // ★ 先定稿没落定的调色、再记这一笔（顺序不能反）。
  //   反了的话这一刀会压到"调色那笔"前面 —— 用户按一下「上一步」，退掉的是
  //   **两件事**（调色 + 裁剪），而他只按了一下。
  flushEdit()
  // ★ 2026-10-08（Task 5 顺手件）：**这一下到底记上了没有，不许静默**。
  //   `at` 是出发那一刻"人在哪一版"（await 之前读的），而下面那个 updater
  //   里找不到它就**原样返回** —— 那种情况下这一下只改了画面、账本上什么都没
  //   留下，退都退不回来，而屏幕上一切正常。理论上到不了（人站的那一版必然
  //   在历史里），真到了就是一件必须留证的事。
  //   ⚠️ 查的是**闭包里的 `history`**（`at` 也是那一刻读的，两者同一拍）；
  //   它**不替 updater 做决定** —— 那半边（`if (s.id !== at) return s`）
  //   一个字都不动，这里只是把静默变成一行日志。
  if (!history.some(s => s.id === at)) {
    console.error('账本没记上：那一版不在了（id ' + String(at) + '）—— ' + what + '只改了画面，退不回去')
  }
  // ⚠️ 发号器是 `editSeqRef`（**账本专用**，和 `idRef` 分开）——
  //   账本序号只管预算驱逐的先后，发它**不产生新版本**。
  const seq = ++editSeqRef.current
  setHistory(prev => {
    const next = prev.map(s => {
      // 找不到 `at` 就原样返回 —— 理论上到不了（有照片 ⇒ 位置非空），
      // 但**别顺手拿"最接近的那一版"顶上**：记错版本 = 光标和画面对不上，
      // 而且一句错都不报。
      if (s.id !== at) return s
      const before: EditState = {
        base: s.base, params: s.params, lut: s.lut, layers: s.layers,
        label: s.editLabel, seq,
      }
      // "之后"取**这一版自己的** params/lut —— 它就是"当前这一版"的现场
      // （写回那条 effect 一直在把它们镜像成最新）；裁剪/擦除只换底图，不动调色。
      return pushEdit(s, before, {
        base, params: s.params, lut: s.lut,
        layers: layers !== undefined ? layers : s.layers,
        label: editLabelFor(what),
      }, seq)
    })
    // ★ Task 5：记完这一笔 → 预算闸 + 位图回收（`settleLedger` 里两件事一起做）。
    //   记账**不切未来**，所以回收那一半通常一张都不关："裁之前"那张进了账本、
    //   还被 `past` 引用着（关了 = 退回去时闪黑）。
    return settleLedger(prev, next)
  })
  // ★（评审 Critical）**底图换了一版，落盘的账要记上** —— 这一版现在
  //   脏了，而且脏的是**像素**（`baseChanged`）：下一趟 PUT 才会把这张
  //   裁出来 / 擦出来的底图送上去。不记的话服务端手里还是**没裁过**的那张，
  //   重开之后画面是原图 —— 一句错都不报。
  //   （★ Task 7 之前这儿推的是 `baseSeqRef`；那个号今天只管竞态闸门，
  //    落盘改认 `dirtyRef`，见 `markDirty` 那段。`patch.thumb` 也跟着它一起重传。）
  baseSeqRef.current++
  // ⚠️ `at` 类型上是 `number | null`（读的是影子 ref），但走到这儿它一定非空
  //   —— "有照片 ⇒ 位置非空"那条不变量管着（调用点也有 `!image` 那道早返回）。
  //   这里只是让类型过得去；真为 null 的话上面已经报过「账本没记上」，轮不到这行。
  if (at !== null) markDirty(at, true)
  setImage(base)
  if (layers !== undefined) setLayers?.(layers)
  // ★ 终审 I3：**底图换了 = 那批"上一条照片的临时状态"一起清** —— `onPick` /
  //   `loadSession` / `resetEditor` 三处都写着这条规矩，裁剪 / 点修是第四、五个
  //   换底图的地方（原来漏了；两条后果各有一半是"错了不报错"，见 `clearTransient`）。
  clearTransient()
}

/**
 * 只改**文字层**（不动底图像素）的一笔。
 *
 * 和 `applyBaseEdit` 同一条账本 / 定稿 / 落盘规矩，但：
 *   · `base` 不换，所以不推 `baseSeqRef`、不重传底图；
 *   · `layersChanged` 让落盘那一趟知道要更新封面（文字层不在 WebGL 画布里）；
 *   · 调用方负责把 `setLayers` 设成同一份数组（这里只写历史）。
 */
export type LayersEditCommit = {
  at: number | null
  history: readonly Snapshot[]
  setHistory: Dispatch<SetStateAction<Snapshot[]>>
  editSeqRef: { current: number }
  markDirty: (stepId: number, baseChanged: boolean, layersChanged?: boolean) => void
  flushEdit: () => void
}

export function applyLayersEdit(
  deps: LayersEditCommit, layers: EditLayer[], label = '文字',
): void {
  const { at, history, setHistory, editSeqRef, markDirty, flushEdit } = deps
  flushEdit()
  if (!history.some(s => s.id === at)) {
    console.error('账本没记上：那一版不在了（id ' + String(at) + '）—— 文字层只改了画面，退不回去')
    return
  }
  const seq = ++editSeqRef.current
  setHistory(prev => {
    const next = prev.map(s => {
      if (s.id !== at) return s
      const before: EditState = {
        base: s.base, params: s.params, lut: s.lut, layers: s.layers,
        label: s.editLabel, seq,
      }
      return pushEdit(s, before, {
        base: s.base, params: s.params, lut: s.lut, layers, label,
      }, seq)
    })
    return settleLedger(prev, next)
  })
  if (at !== null) markDirty(at, false, true)
}
