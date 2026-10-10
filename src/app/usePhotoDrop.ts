import { useEffect, useRef, useState } from 'react'

/**
 * ★ 2026-10-10：**把另一张照片拖进来（或粘进来）= 换一张改**。
 *
 * 加它的来路：全库唯一一个拖放区在欢迎屏（`ui/Uploader`）—— "手上已经有一张、
 * 又想把刚拍的换上来"要走「新的一张」→ 回欢迎屏 → 再拖，三步。拖进窗口一步。
 *
 * ⚠️ **浏览器对文件拖放的默认行为是"导航过去打开它"**（整页跳走，手上没落盘的
 *   改动全没）。所以 `dragover` / `drop` 的 `preventDefault` **在所有画面都做**
 *   （调色屏、作品页也防），只是"接住"（显示提示层、真去换图）只在 `active`
 *   的地方发生。
 *
 * ⚠️ **只在"手上有一张"时接**：没有照片时那一屏是欢迎页的地盘，它的拖放区
 *   自己管（`Uploader` 的 onDrop）——这里再插一手会和它抢。
 *
 * `onDrop(file)` 由调用方决定语义（App 那边 = 先 flush 再 `onPick`，
 * 和「新的一张」同一趟处理）。本 hook 只管"什么时候、从哪个事件里拿到文件"。
 *
 * 返回值是"此刻有没有文件悬在窗口上"（给提示层用）。
 */
export function usePhotoDrop(opts: {
  /** 现在能不能接（App 传的是"修图屏 && 有照片 && 不忙"）。 */
  active: boolean
  onDrop: (file: File) => void
}): boolean {
  const { active, onDrop } = opts
  /**
   * 有文件"悬"在窗口上没有（显示提示层）。
   * ⚠️ `dragenter` / `dragleave` 在**子元素之间穿梭时会反复触发**（进一次出一次）
   *   —— 所以用**计数器**（进 +1、出 -1、到 0 才收），这是拖放这块的经典坑，
   *   只盯 dragleave 的话指标在元素边上抖一下提示层就开始闪。
   */
  const [dragging, setDragging] = useState(false)

  // 监听只手挂一次（见下面空依赖），处理函数从 ref 里读"当前"的 active / onDrop
  // —— 挂进依赖的话，每次重渲染都重挂一遍 document 监听（还会把计数器打断）。
  const activeRef = useRef(active)
  const onDropRef = useRef(onDrop)
  const depthRef = useRef(0)
  useEffect(() => {
    activeRef.current = active
    onDropRef.current = onDrop
  })

  // 不能接了（换了屏 / 忙了）就把"悬着"的状态收掉 —— 不然提示层会留在屏上。
  useEffect(() => {
    if (!active && depthRef.current !== 0) {
      depthRef.current = 0
      setDragging(false)
    }
  }, [active])

  useEffect(() => {
    /** 这次拖放带的是**文件**吗（拖一段选中的文字不是）。 */
    const hasFiles = (dt: DataTransfer | null | undefined) => !!dt?.types.includes('Files')
    /** 拖放里带的第一个文件（没有就是 null）。 */
    const firstFile = (dt: DataTransfer | null | undefined): File | null =>
      (dt?.files && dt.files.length > 0) ? dt.files[0]! : null

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      depthRef.current++
      if (activeRef.current) setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      // ⚠️ 全画面都防（不 active 也要防）—— 不防的话用户拖到调色屏上松手，
      //    浏览器就把那张图当网页打开了，整页跳走。
      e.preventDefault()
      if (activeRef.current && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = () => {
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setDragging(false)
    }
    const onDropEvent = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depthRef.current = 0
      setDragging(false)
      if (!activeRef.current) return
      const f = firstFile(e.dataTransfer)
      if (f) onDropRef.current(f)
    }
    /** 粘贴：剪贴板里有一张图就用它（截屏、从聊天软件里复制来的照片都走这条）。 */
    const onPaste = (e: ClipboardEvent) => {
      if (!activeRef.current) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) { onDropRef.current(f); return }
        }
      }
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDropEvent)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDropEvent)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  return dragging
}
