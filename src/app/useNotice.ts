import { useCallback, useEffect, useState } from 'react'

/** 通报的一句话 + 语气（`ok` 几秒后自己走，`bad` 留着等用户点掉）。 */
export type Notice = { text: string; tone: 'ok' | 'bad' }

/**
 * 顶上那条**通报**（★ 2026-09-30 立、2026-10-08 从 `App.tsx` 搬出来）：
 * 有件事要跟你说一声，说完可以收走。
 *
 *  它取代了原来三处 `window.alert`。系统弹窗有两个毛病：它把整页冻住，
 *  而且长得**不像这个产品的一部分** —— 一个花了一整天做视觉的产品，
 *  出错时突然跳出一个灰扑扑的系统框，那一下就把"做完了"的感觉打回去了。
 *
 *  `tone` 只有两种：`bad`（这件事没成，留着等用户看完自己点掉 ——
 *  他可能要去别处看一眼再决定怎么办）和 `ok`（成了，几秒后自己走）。
 *
 *  ★ **「存好了」也走这里，不是因为它是个错误**：手机上打开调色面板时
 *  **对话栏整个是隐藏的**（面板和对话在抢竖向空间，见 styles.css 那条 `:has`），
 *  而那一刻正是用户拖完滑块、按「保存」的时候 —— 那句话会落进
 *  **一个用户看不见的地方**。（2026-09-30 全链路回归在手机那趟抓到的：
 *  桌面那一趟全绿，只有"打开面板再保存"这一串下来屏上什么都没有。）
 *
 *  ⚠️ 它和 `saveFail` 是**两种东西，别合并**：那条横幅是"图还在，先拿到手"，
 *  自带一个下载按钮，而且**不许被关掉**（关掉用户就真的拿不到那张图了）；
 *  这条只是通报，「知道了」就该收走。
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 通报一句"没成"。**身份必须是稳定的** —— 它直接传给 Canvas 的 `onFail`，
   *  而那边进了 effect 的依赖数组（理由见 Canvas.tsx 那段）。 */
  const noticeBad = useCallback((text: string) => setNotice({ text, tone: 'bad' }), [])
  /** 通报一句"成了"。和 `noticeBad` 一样，身份必须稳定（两者都会进
   *  `useDelivery` 的依赖数组）。 */
  const noticeOk = useCallback((text: string) => setNotice({ text, tone: 'ok' }), [])

  // "成了"的通报自己会走：它是**回执**，不是待办。
  // 用函数式更新加一道守卫 —— 这几秒里用户可能已经触发了别的通报，
  // 无条件 `setNotice(null)` 会把**新的那条**一起抹掉。
  useEffect(() => {
    if (notice?.tone !== 'ok') return
    const t = setTimeout(() => setNotice(n => (n?.tone === 'ok' ? null : n)), 4000)
    return () => clearTimeout(t)
  }, [notice])

  return { notice, setNotice, noticeBad, noticeOk }
}
