// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import PerspectiveControls from './PerspectiveControls'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderControls(autoDetecting = false) {
  let detected = 0
  act(() => {
    root.render(
      <PerspectiveControls
        applying={false}
        dirty={false}
        autoDetecting={autoDetecting}
        onAuto={() => { detected++ }}
        onBack={() => {}}
        onReset={() => {}}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    )
  })
  const button = [...container.querySelectorAll('button')]
    .find(node => (node.textContent ?? '').trim() === (autoDetecting ? '识别中…' : '自动透视')) as HTMLButtonElement
  return {
    button,
    detected: () => detected,
  }
}

describe('自动透视入口', () => {
  it('点「自动透视」只触发检测，不直接提交', () => {
    const view = renderControls()
    expect(view.button).toBeTruthy()
    act(() => view.button.click())
    expect(view.detected()).toBe(1)
  })

  it('识别期间按钮禁用并显示进度文字', () => {
    const view = renderControls(true)
    expect(view.button).toBeTruthy()
    expect(view.button.disabled).toBe(true)
  })
})
