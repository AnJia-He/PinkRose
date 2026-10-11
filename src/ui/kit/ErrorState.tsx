/**
 * 「打不开」标准件：**居中一句 + 一颗能点的出口**。
 *
 * ★ 2026-10-11（设计跟进 Task 2）。换掉的是三页各自那份"左上角一行红字 +
 * 一句空话"。病根不在红字，在**没有出口**：图没出来、屏幕上一句话，用户能做的
 * 只有"刷新页面"——而那句话还是劝他这么干的（「刷新一下页面，再试一次。」
 * 这句 2026-10-11 退役）。错误态和空态本来就该是一副样子：**都说清"怎么了"，
 * 都留一条"下一步"** —— 空态有「去改一张」，错误态就得有「再试一次」。
 *
 * 长相连着空态那一族（`.empty-state*`，见 SessionsPage 的空态）复用：
 * 类名拼的是**同一个** `.empty-state`，新增的只有 `.error-state` 这一点微调
 * （间距：错误态常常整页就这一件，和 `.sessions-empty` 一样要往下压一点）。
 * 别在这里发明第二套"居中的字"样式。
 *
 * ⚠️ 「再试一次」按下去重跑的是**外面那一趟 fetch**（`onRetry` 由页面接线）——
 *   这个组件自己不知道数据从哪来，也别让它在里面偷偷 `location.reload()`：
 *   整页刷新会把用户在这一屏之外的东西也冲掉（这正是本轮要治的病）。
 * ⚠️ `retryLabel` 存在的理由是详情页 404：那张作品**没了**，再"试"一万次也
 *   不会回来 —— 那种页面的出口是「回作品」，一颗换名字的按钮。
 */
import { Btn } from './Btn.tsx'

export function ErrorState(props: {
  /** 说给用户的那句话（"怎么了"）。服务端的人话原样传进来即可。 */
  text: string
  /** 点了重跑外面那一趟 fetch。 */
  onRetry: () => void
  /** 默认「再试一次」；"重试救不回来"的场合换名字（详情页 404 是「回作品」）。 */
  retryLabel?: string
}) {
  return (
    <div className="empty-state error-state">
      <p className="empty-state-title">{props.text}</p>
      <Btn onClick={props.onRetry}>{props.retryLabel ?? '再试一次'}</Btn>
    </div>
  )
}
