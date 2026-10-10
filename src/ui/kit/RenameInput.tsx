import { X } from 'lucide-react'

/** 那颗「取消」的类名。**输入框的 blur 要认它**（见下面那段），所以给个名字。 */
const CANCEL = 'rename-cancel'

/**
 * **就地改名**那一格输入框 + 它旁边那颗「取消」 —— 作品详情页 / 对话列表 /
 * 对话栏顶上那颗铅笔，三处共用这一份。
 *
 * ★ 2026-10-09 收口：前两处各写过一遍（`WorkDetailPage.rename-input` /
 *   `SessionsPage.session-rename`），对话栏这一次是**第三遍** —— 收成一份。
 *   搬的是**手势**，不是长相：类名、预填值、上限、可访问的名字全由调用方给
 *   （三处的排版各不相同，见各自那条 CSS）。
 *
 * ★★ 2026-10-09（当天晚些，用户截图 + 原话：「**这个修改时没法退出**」）：
 *   **补一颗可见的「取消」**。
 *   在这之前，进了编辑态那一行上**一个可点的东西都没有**（铅笔自己也被输入框
 *   顶掉了），出口只剩两个：Esc（看不见的），和"点别处"—— 而那是**保存**，
 *   不是退出。用户想反悔的时候，屏幕上没有任何东西告诉他怎么办。
 *   ⚠️ 三处都会有这颗，因为它长在这个共用件里 —— 那两处（作品详情 / 对话列表）
 *   是一模一样的毛病，只是他先在对话栏上撞到。
 *
 * ⚠️ 手势只有这一套，别在某一处另写一遍：
 *   · 一出现就 `autoFocus`（点「改名」之后手不用再去点输入框）；
 *   · **回车 / 点走保存**、**Esc 或那颗 ✕ 取消**；
 *   · 保存**只发一次** —— 回车 / Esc / ✕ 之后输入框被卸载，浏览器**不补 blur**
 *     （作品页顶了四天的那条，SessionsPage 的测试用"请求计数 === 1"钉着）。
 *
 * ★ 2026-10-10：第四处 —— 调色面板「我的预设」里每一行的改名（`PresetManager`）。
 *   上限（30）和可访问的名字（「预设名字」）由它那边给。
 *
 * ⚠️ 它**不套壳**，两颗东西是**兄弟**（一个 fragment）：
 *   各处调用方都给输入框的类挂了 `flex: 1`（`.detail-head` / `.session-row` /
 *   `.chat-head` / ★ 10-10 加的 `.my-presets-rename` 那一行的 flex 孩子），
 *   包一层 `div` 会让那个 `flex: 1` 落错地方 —— 作品详情页那段注释专门写过这件事。
 */
export function RenameInput({
  className, defaultValue, placeholder, maxLength, ariaLabel, onCommit, onCancel,
}: {
  className: string
  /** 预填**显示名**（不是字段值）—— 空着提交 = 回退，`placeholder` 是那时候露出来的"会变回这个名字"。 */
  defaultValue: string
  placeholder?: string
  maxLength?: number
  /** 屏幕上没有可见的字（它顶掉的就是那个标题），所以名字只能给在这儿。 */
  ariaLabel: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  return (
    <>
      <input className={className} autoFocus
             defaultValue={defaultValue} placeholder={placeholder} maxLength={maxLength}
             aria-label={ariaLabel}
             onBlur={e => {
               // ⚠️ **焦点移到旁边那颗「取消」上不算"点走保存"**。
               //    少了这一句，键盘用户 Tab 过去准备取消时，光标一离开输入框
               //    名字就先存了 —— 那颗「取消」当场消失，他按了个寂寞。
               //    （鼠标那条路不会走到这儿：✕ 的 `onMouseDown` 已经把
               //    默认行为挡掉了，输入框压根不失焦。）
               if ((e.relatedTarget as HTMLElement | null)?.classList.contains(CANCEL)) return
               onCommit(e.target.value)
             }}
             onKeyDown={e => {
               // ⚠️ `isComposing`：中文输入法**选词**也是回车 —— 不挡的话
               //    用户打个"海边"选词，名字会半截存成"海"（一声不吭）。
               if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                 onCommit((e.target as HTMLInputElement).value)
               if (e.key === 'Escape') onCancel()
             }} />
      {/* 图标键（屏幕上没有字）—— 名字只在 `aria-label` 上，和这一行那颗铅笔
          同一条规矩。`aria-hidden` 的图标不进 textContent，所以"按文字找按钮"
          的地方不会认错。
          ⚠️ `type="button"`：作品详情那一处和 `<form>` 毫无关系，但少写它
             哪天被挪进表单里就是"按一下取消、顺手把表单提交了"。
          ⚠️ `onMouseDown` 里那句 `preventDefault` **不是可选的**：不挡的话，
             鼠标按下去的那一瞬间输入框先失焦 → 走 `onBlur` → **名字已经存了**，
             然后才轮到这儿的 `onClick` 去"取消"（太晚了）。 */}
      <button type="button" className={CANCEL} aria-label="取消"
              onMouseDown={e => e.preventDefault()}
              onClick={onCancel}>
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </>
  )
}
