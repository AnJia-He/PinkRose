/**
 * 一格表单 = 标签 + 输入框 + 注解。
 *
 * **全站只有这一个长相。** 换它之前这里同时住着三套写法：
 *   · 名字/邮箱那种 —— 把输入框**包进** `<label>` 里（隐式关联）
 *   · 密码那一格 —— `<div>` + `<label htmlFor>`（**有理由**，见 LoginPage 里那段：
 *     label 里放 `<button>` 会把按钮上的字算进输入框的可读名字）
 *   · 搜索框 —— **没有标签**，只有 placeholder
 * 三套的注解（"两到二十个字"这种）**都没有和输入框连起来**：
 * 全仓 `aria-describedby` 一条都没有，读屏的人念不到。
 *
 * ⚠️ 为什么走 Base UI 的 `Field` 而不是自己写一个 `<div><label><input>`：
 * 它会把 label / 注解 / 错误和控件**用 id 自动连起来**
 * （`for` + `aria-labelledby` + `aria-describedby`）—— 那正是上面缺的那一块，
 * 自己写等于又把这活派给自己，而且每个页面还得各写一遍。
 *
 * ⚠️ 它**不提供任何长相**：`className` 直接落在它渲染的那个 `<div>` 上，
 * 颜色/间距全部由 `src/styles.css` 里我们自己的规则说了算。
 * 测试也是按这个类名找元素的（`.login-field input[name=…]` 那一路）。
 */
import { Field as BaseField } from '@base-ui-components/react/field'

export function Field(props: {
  /** 我们的类名（`.login-field` / `.models-field` …）—— 落在最外层那个 div 上 */
  className?: string
  /** 标签那一行的内容。要加"必填星号"这类零星记号，直接写在这里面 */
  label: React.ReactNode
  /** 标签下面、输入框下面那行小字。给了就一定和输入框连上（aria-describedby） */
  hint?: React.ReactNode
  /** 注解那行 `<p>` 的类名（`.models-hint` 这种）。
   *  ⚠️ 故意**不给默认值**：注解长什么样是各自的领地（模型设置那页和别处不同），
   *  这里塞一个默认类名，等于凭空多出一个"摆着没人用"的类。 */
  hintClassName?: string
  children: React.ReactNode
}) {
  return (
    <BaseField.Root className={props.className}>
      <BaseField.Label>{props.label}</BaseField.Label>
      {props.children}
      {props.hint
        ? <BaseField.Description className={props.hintClassName}>{props.hint}</BaseField.Description>
        : null}
    </BaseField.Root>
  )
}

/** 输入框本体。
 *
 * ⚠️ **`Field` 里的输入框必须用它，不能放裸 `<input>`** —— 裸的那个拿不到
 * Base UI 发下来的 `id` 和 `aria-*`，那这一层就白引了（而且会静默地白引：
 * 页面上看不出任何差别，只有读屏的人吃亏）。
 *
 * 原生属性照常透传（`name` / `type` / `autoComplete` / `list` / `inputMode` …）。
 */
export function TextInput(props: React.ComponentProps<'input'>) {
  return <BaseField.Control render={<input {...props} />} />
}
