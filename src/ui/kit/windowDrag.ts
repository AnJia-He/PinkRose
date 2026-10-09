/**
 * 把一套 pointer 手势挂在 **window** 上 —— 拖动时手拖出元素是常态
 * （转盘转圈 / 照片平移 / 裁剪框 / 涂抹 / 对比把手，五处都靠它）。
 *
 * ★ 2026-10-09 收口：这段"三个监听 + 那句安全注释"在五个组件里各抄了一遍
 *   （连注释都是同一句）。抄五遍的代价不是行数，是**那条规矩会漂**。
 *
 * ⚠️ **三种"松手"必须一起接**：抬手、系统把指针抢走（来电、通知、滚动接管）、
 *   取消 —— 少接一个，用户按一下就会被**永久留在拖动状态**里，而且他没有任何
 *   办法按回来（`Canvas` 那句注释写的就是这个）。
 *
 * ⚠️ **别用 `setPointerCapture`** —— 一捕获，紧随其后的那一下 `click` 会落到
 *   容器上（`StepStrip` 真踩过：转完一格顺手多跳了一步）。
 *
 * 两种收场方式，按调用点的需要挑：
 *   · `stop()` —— 摘监听 **+ 喊 `onEnd`**。抬手 / 被抢走时它自己会走，
 *     组件卸载、"上一趟还挂着"时由调用方再调一次（`Canvas` / `RetouchOverlay`
 *     的 `stopRef` 就是它）。**幂等**：抬手之后再调不会把 `onEnd` 喊第二遍。
 *   · `detach()` —— **只摘监听、不喊 `onEnd`**。effect 的 cleanup 用这个：
 *     那一趟是"依赖变了、重新挂一遍"，不是"用户松手了"，不该触发收场
 *     （`StepStrip` 转着圈时新来一步就是这样，收场会把它弹到最近的一格）。
 */
export type WindowDrag = {
  stop: () => void
  detach: () => void
}

export function bindWindowDrag(
  onMove: (e: PointerEvent) => void,
  onEnd: () => void,
): WindowDrag {
  let ended = false

  // 两个都是函数声明（不是 const 箭头）：`detach` 要引用后面才定义的 `finish`，
  // 声明会提升，不存在"先用后声明"那档事。
  function detach() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
  }
  function finish() {
    if (ended) return
    ended = true
    detach()
    onEnd()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)

  return { stop: finish, detach }
}
