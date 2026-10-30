// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { FaceBox } from '../core/faceDetect'
import ManualFaceOverlay from './ManualFaceOverlay'

const BOX = { left: 0, top: 0, width: 800, height: 600 }
let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
})

async function mount() {
  const picked: FaceBox[] = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <ManualFaceOverlay
        box={BOX}
        imageWidth={800}
        imageHeight={600}
        onPick={face => picked.push(face)}
      />,
    )
  })
  return {
    picked,
    overlay: () => container!.querySelector('.face-pick') as HTMLElement,
    frame: () => container!.querySelector('.face-pick-frame') as HTMLElement | null,
  }
}

const press = (el: Element, key: string, shiftKey = false) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key, shiftKey, bubbles: true, cancelable: true,
    }))
  })

describe('手动圈脸的键盘兜底', () => {
  it('Enter 放置居中脸框，预览先出现但不立即提交', async () => {
    const view = await mount()
    expect(view.overlay().tabIndex).toBe(0)
    await press(view.overlay(), 'Enter')
    expect(view.frame()).not.toBeNull()
    expect(view.picked).toHaveLength(0)
  })

  it('方向键移动、Shift 加速、加减键缩放，Enter 才提交', async () => {
    const view = await mount()
    const overlay = view.overlay()
    await press(overlay, 'Enter')
    await press(overlay, 'ArrowRight')
    await press(overlay, 'ArrowDown', true)
    await press(overlay, '+')
    await press(overlay, 'Enter')
    const face = view.picked.at(-1)!
    expect(face.x).toBe(273)
    expect(face.y).toBe(166)
    expect(face.w).toBe(260)
    expect(face.h).toBe(292)
  })

  it('Escape 丢弃草稿；缩到最小边后不会继续变小', async () => {
    const view = await mount()
    const overlay = view.overlay()
    await press(overlay, 'Enter')
    for (let i = 0; i < 200; i++) await press(overlay, '-', true)
    await press(overlay, 'Enter')
    const face = view.picked.at(-1)!
    expect(face.w).toBeGreaterThanOrEqual(24)
    expect(face.h).toBeGreaterThanOrEqual(24)

    await press(overlay, 'Home')
    expect(view.frame()).not.toBeNull()
    await press(overlay, 'Escape')
    expect(view.frame()).toBeNull()
  })
})
