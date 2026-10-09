import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

/**
 * 「滚到底就把下一段接上」的哨兵 —— 作品页和对话列表页是**一字不差**的同一段
 * （那边原来的注释自己写着"和作品页那个哨兵一模一样"）。
 *
 * ★ 2026-10-09 收口。用法：`const sentinel = useLoadMoreSentinel(more, PAGE, setLimit)`，
 *   把返回的 ref 挂到列表**最后**那个 `<div ref={sentinel} />` 上。
 *
 * ⚠️ `more` 进依赖：还有更多才观察；`more` 变 false 时 observer 撤掉，
 *   等它再变 true 时重挂 —— "滚到底发现没有了就不再挂"靠的就是这一步。
 * ⚠️ 第三个参数收的是 **React 的 setter**（身份永远稳定），不是一个现包的回调 ——
 *   包一层的话每一渲染都是新身份，effect 会跟着重挂 observer。
 * ⚠️ 取整那件事（"按天分组、一次加一篇日记那么多"）在各页自己算，这里只管
 *   滚到底喊一声：`setLimit(n => n + step)`。
 */
export function useLoadMoreSentinel(
  more: boolean, step: number, setLimit: Dispatch<SetStateAction<number>>,
): MutableRefObject<HTMLDivElement | null> {
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((es) => {
      if (es.some(e => e.isIntersecting)) setLimit(n => n + step)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [more, step, setLimit])
  return sentinel
}
