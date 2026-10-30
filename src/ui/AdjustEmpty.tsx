import { lazy, Suspense, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import type { Appearance } from '../app/appearance.ts'

const CameraBridge = lazy(() => import('./CameraBridge.tsx'))

type Props = {
  /** 和欢迎页那颗「选照片」**同一个动作、同一个去处**（`App` 的 `onPick`）——
   *  选完就落回**这一屏**（调色），因为这一屏本来就是用户点进来的地方。 */
  onPick: (file: File, wish: string, sidecar?: File) => void
  /** 相机桥 / 文件夹等一次取回多张时，交给批量处理。 */
  onPickMany?: (files: File[], wish: string, sidecars?: File[]) => void
  /** 相机包围曝光整组 → HDR 合成。 */
  onHdrMany?: (files: File[]) => void
  /** 焦点包围整组 → 焦点堆栈。 */
  onFocusMany?: (files: File[]) => void
  appearance?: Appearance
}

/**
 * 调色那一屏的**空态**：手上还没有照片时，照片那块地方长这样。
 *
 * ★ 2026-10-04（当天第三遍）：用户看完前两版说
 * 「**调色要一直在导航栏，没有图片的时候显示图片的地方提示还没有照片不就好了？**」
 *
 * 前两版错在**把那一格藏起来**（理由写得很像回事：那是"关于这张照片的工具，
 * 照片在才有"）。用户一句话点破：**要藏的不是入口，是"没东西可看"这件事本身** ——
 * 左边那一列是"这里有哪几件事"，一件事在不在，不该随手上有没有照片变。
 *
 * 所以这一屏现在的形状是：**左栏那一格一直在**（点亮着），照片那块地方说一句
 * **还没有照片**，下面给一颗**怎么办**的按钮 —— 和对话列表那条空态
 * （`.sessions-empty`，「还没改过照片。」+「去改一张」）**是同一个句式**，
 * 照的都是 §3.7：**主句说现状，按钮说"那怎么办"**。
 *
 * ⚠️ 和欢迎页（`Uploader.tsx`）**不是一回事**，别合并：
 *   · 那一屏是"**登录之后看到的第一张脸**"，要介绍这个产品是什么（标志、
 *     一句话、那条对话输入框、背景那颗图片球）；
 *   · 这一屏是"**我已经在用这个工具了，只是手上这张没了**"—— 一句现状 + 一条出路。
 *   合并回去就退回了 2026-10-04 那版：用户点「调色」看到的还是欢迎页，
 *   **看着就像点了没反应**。
 *
 * ⚠️ `input` 那一格和欢迎页一样要**留在 DOM 里**（藏起来、由按钮去点它）：
 * `check:layout` 靠 `input[type="file"]` 判断"这一屏到了没有"。
 */
export default function AdjustEmpty({
  onPick, onPickMany, onHdrMany, onFocusMany, appearance = 'dark',
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [bridgeOpen, setBridgeOpen] = useState(false)

  return (
    <div className="adjust-empty empty-state">
      <input
        ref={fileRef}
        className="composer-file"
        type="file"
        accept="image/*,.heic,.heif"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onPick(f, '')
          // 清空 value：同一张照片连选两次也要能再触发一次 change
          e.target.value = ''
        }}
      />
      <p className="empty-state-title">还没有照片。</p>
      <div className="adjust-empty-actions">
        <Btn className="primary" onClick={() => fileRef.current?.click()}>选一张照片</Btn>
        <button
          type="button"
          className="adjust-empty-secondary"
          onClick={() => setBridgeOpen(true)}
        >
          <FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
          从相机导入
        </button>
      </div>
      {bridgeOpen && (
        <Suspense fallback={(
          <div className="camera-dialog" data-theme={appearance} role="status">
            <div className="camera-panel camera-loading">正在打开相机桥…</div>
          </div>
        )}>
          <CameraBridge
            open
            appearance={appearance}
            onClose={() => setBridgeOpen(false)}
            onImport={(file, sidecar) => {
              setBridgeOpen(false)
              if (sidecar) onPick(file, '', sidecar)
              else onPick(file, '')
            }}
            onImportMany={(files, sidecars) => {
              setBridgeOpen(false)
              if (sidecars?.length) onPickMany?.(files, '', sidecars)
              else onPickMany?.(files, '')
            }}
            onHdrMany={files => {
              setBridgeOpen(false)
              onHdrMany?.(files)
            }}
            onFocusMany={files => {
              setBridgeOpen(false)
              onFocusMany?.(files)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
