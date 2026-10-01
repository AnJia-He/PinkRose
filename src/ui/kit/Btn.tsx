/**
 * 主按钮：**全站只有这一个长相**。
 *
 * 换之前这份长相住在 CSS 的一条**四个选择器的列表**里
 * （`button.primary, .save-fail button.download, .login-submit, .detail-download`，
 * 见 styles.css 那段注释），靠一条口头约定维持："加一种新载体，记得把新选择器
 * 加进那个列表"。那条约定的毛病是**它不会报错** —— 漏加一处，屏幕上就出现两颗
 * 不一样的按钮，而且没人会发现（CSS 是静默的）。
 * 现在长相是一个组件：新加载体时 import 它，长相自己跟过来。
 *
 * ⚠️ **尺寸/内边距/占不占满一行不在这里** —— 那是各处的版面（登录页那颗要占满
 * 一行、顶栏那颗要小一号），仍然由 `className` 传进来、写在 `styles.css` 里。
 * 这个组件只管"底色、字色、字重、悬停"这四样。
 *
 * ⚠️ 各处原来的类名（`.login-submit` / `.detail-download` / `.download` /
 * `.primary`）**一个都没省** —— 它们是测试和 CSS 的锚点，`className` 会原样
 * 拼在 `btn-primary` 后面。
 */

function cls(extra?: string) {
  return extra ? `btn-primary ${extra}` : 'btn-primary'
}

/** 主按钮本体（`<button>` 那一种）。不传 `type` 时是 `button` —— 表单里
 *  不写 `type` 的 `<button>` 默认是 `submit`，那是这个项目踩过的坑。 */
export function Btn(props: {
  className?: string
  children: React.ReactNode
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={cls(props.className)}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** 同长相的**链接**版：`download` 属性只有真 `<a>` 带得动
 *  （详情页「下载到我的电脑」就是它）。 */
export function BtnLink(props: {
  className?: string
  children: React.ReactNode
  href: string
  download?: string
}) {
  return (
    <a href={props.href} download={props.download} className={cls(props.className)}>
      {props.children}
    </a>
  )
}
