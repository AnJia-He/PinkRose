/**
 * **就地改名**那一格输入框 —— 作品详情页 / 对话列表 / 对话栏顶上那颗铅笔，
 * 三处共用这一份。
 *
 * ★ 2026-10-09 收口：前两处各写过一遍（`WorkDetailPage.rename-input` /
 *   `SessionsPage.session-rename`），对话栏这一次是**第三遍** —— 收成一份。
 *   搬的是**手势**，不是长相：类名、预填值、上限、可访问的名字全由调用方给
 *   （三处的排版各不相同，见各自那条 CSS）。
 *
 * ⚠️ 手势只有这一套，别在某一处另写一遍：
 *   · 一出现就 `autoFocus`（点「改名」之后手不用再去点输入框）；
 *   · **回车 / 点走保存**、**Esc 取消**，没有「好 / 取消」两颗按钮；
 *   · 保存**只发一次** —— 回车和 Esc 之后输入框被卸载，浏览器**不补 blur**
 *     （作品页顶了四天的那条，SessionsPage 的测试用"请求计数 === 1"钉着）。
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
    <input className={className} autoFocus
           defaultValue={defaultValue} placeholder={placeholder} maxLength={maxLength}
           aria-label={ariaLabel}
           onBlur={e => onCommit(e.target.value)}
           onKeyDown={e => {
             // ⚠️ `isComposing`：中文输入法**选词**也是回车 —— 不挡的话
             //    用户打个"海边"选词，名字会半截存成"海"（一声不吭）。
             if (e.key === 'Enter' && !e.nativeEvent.isComposing)
               onCommit((e.target as HTMLInputElement).value)
             if (e.key === 'Escape') onCancel()
           }} />
  )
}
