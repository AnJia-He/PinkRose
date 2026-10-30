import { useEffect, useRef, useState } from 'react'
import { imageFileFormat, isRawFileName } from '../../shared/imageFormats.ts'

const BROWSER_IMAGE_NAME = /\.(?:jpe?g|png|webp|avif|gif|bmp)$/i

/** RAW / HEIC / TIFF 的 MIME 经常为空，扩展名和共享格式表是主判据。 */
function isPhotoFile(file: File): boolean {
  return file.type.startsWith('image/')
    || BROWSER_IMAGE_NAME.test(file.name)
    || isRawFileName(file.name)
    || imageFileFormat(file.name) !== null
}

function photoFiles(files: FileList | File[] | null | undefined): File[] {
  return Array.from(files ?? []).filter(isPhotoFile)
}

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
 * `onDrop(files)` 由调用方决定语义（App 那边 = 单张替换当前照片，
 * 多张统一送批量处理；两条路都先 flush）。本 hook 只管"什么时候、
 * 从哪个事件里拿到哪几张照片"。
 *
 * 返回值是此刻悬在窗口上的文件数（0 = 没有，给提示层用）。拖放系统在
 * `dragenter` 时可能还没填 `files`，所以提示数从 `items` 兜底；真正落地
 * 只认 `files` 里的照片。
 */
export function usePhotoDrop(opts: {
  /** 现在能不能接（App 传的是"修图屏 && 有照片 && 不忙"）。 */
  active: boolean
  onDrop: (files: File[]) => void
}): number {
  const { active, onDrop } = opts
  /**
   * 有文件"悬"在窗口上没有（显示提示层）。
   * ⚠️ `dragenter` / `dragleave` 在**子元素之间穿梭时会反复触发**（进一次出一次）
   *   —— 所以用**计数器**（进 +1、出 -1、到 0 才收），这是拖放这块的经典坑，
   *   只盯 dragleave 的话指标在元素边上抖一下提示层就开始闪。
   */
  const [dragging, setDragging] = useState(0)

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
      setDragging(0)
    }
  }, [active])

  useEffect(() => {
    /** 这次拖放带的是**文件**吗（拖一段选中的文字不是）。 */
    const hasFiles = (dt: DataTransfer | null | undefined) => !!dt?.types.includes('Files')
    /** 拖放里带的文件数。`files` 还没就绪时用 `items` 给提示层一个可读的数。 */
    const draggedCount = (dt: DataTransfer | null | undefined): number => {
      const files = photoFiles(dt?.files)
      if (files.length > 0) return files.length
      return Array.from(dt?.items ?? []).filter(item => item.kind === 'file').length
    }

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      depthRef.current++
      if (activeRef.current) setDragging(draggedCount(e.dataTransfer))
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
      if (depthRef.current === 0) setDragging(0)
    }
    const onDropEvent = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depthRef.current = 0
      setDragging(0)
      if (!activeRef.current) return
      const files = photoFiles(e.dataTransfer?.files)
      if (files.length > 0) onDropRef.current(files)
    }
    /** 粘贴：剪贴板里有一张或多张图就走同一条入口（截屏、文件管理器都算）。 */
    const onPaste = (e: ClipboardEvent) => {
      if (!activeRef.current) return
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length > 0) onDropRef.current(files)
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
