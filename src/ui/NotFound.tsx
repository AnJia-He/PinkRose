/**
 * 「没找到这一页」—— **认不出的网址**的落点（`ui/view.ts` 的 `notfound` 那一支）。
 *
 * ★ 2026-10-11（设计跟进 Task 2）。在那之前，认不出的网址被**兜底回落地页**
 *   （见 `view.ts` 顶上那段改向注释）：地址栏里明明是一条打错的网址，屏幕却成了
 *   营销页 —— 用户以为"这产品一打开就这样"，而真正发生的是**链接错了**。
 *   这一页要说的恰恰是那件事，所以说两句话就够：
 *   「没找到这一页」+「地址可能打错了，或者这一页已经不在了。」
 *
 * ⚠️ **地址栏那条网址一个字不改写**（App 里 `go()` 那一侧靠 `pathOf` 还回
 *   `path`，见 `view.ts`）：用户手里那条坏链接得和屏幕上对得上号。
 *
 * ⚠️ 两颗按钮都走 `onGo`（App 的 `go`），**别自己拼网址**：
 *   · 「回到修图」→ `{kind:'edit'}`（登录着的人的正事是回工作台）；
 *   · 「看产品介绍」→ **`{kind:'landing'}`** —— 这一支 `go()` 内部走
 *     `FRONT_PAGE`（`/?home=1`），和左栏那颗「产品介绍」**同一条路**。
 *     自己拼一个 `/` 的话，登录着的人会被那条自动跳转立刻撵回 `/app` ——
 *     这颗按钮成了"点了没反应"（踩过，见 `useNav.ts` 那段）。
 *
 * ★ 2026-10-11 第二眼：游客（没登录）点「回到修图」会落在登录页上 ——
 *   这是**对的**，不是漏了：`/app` 本来就只给登录的人，把他送进去再弹回来
 *   才是骗人。这一页只负责把人领到"地方"，进门那道墙是登录页的事。
 */
import { Btn } from './kit/Btn.tsx'
import type { View } from './view.ts'

export function NotFound({ onGo }: { onGo: (v: View) => void }) {
  return (
    <div className="notfound">
      {/* 居中这一件用的就是空态那一族的皮（`.empty-state*`）—— 和作品页
          空态、对话列表空态是同一副样子，这里不另造一套 "居中的字"。 */}
      <div className="empty-state">
        <p className="empty-state-title">没找到这一页</p>
        <p className="notfound-note">地址可能打错了，或者这一页已经不在了。</p>
        <div className="notfound-actions">
          <Btn onClick={() => onGo({ kind: 'edit' })}>回到修图</Btn>
          {/* 第二颗是**次要**动作（"回修图"才是默认出路），所以它不是主按钮
              长相 —— 但仍然是同一族的形状（药丸），见 styles.css。 */}
          <button className="notfound-secondary" onClick={() => onGo({ kind: 'landing' })}>
            看产品介绍
          </button>
        </div>
      </div>
    </div>
  )
}
