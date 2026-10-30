// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WatermarkControls from './WatermarkControls'
import { DEFAULT_WATERMARK } from '../image/watermark'

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

describe('水印控件', () => {
  it('文字 / 平铺 / 位置都交给上层', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        <WatermarkControls
          idPrefix="t"
          options={DEFAULT_WATERMARK}
          logo={null}
          onChange={onChange}
          onLogo={() => {}}
        />,
      )
    })

    const text = container.querySelector('input[name="t-watermark-text"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(text, 'PinkRose')
      text.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ text: 'PinkRose' }))

    const font = container.querySelector('select[aria-label="水印字体"]') as HTMLSelectElement
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(font, 'serif')
      font.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ font: 'serif' }))

    const tile = container.querySelector('input[name="t-watermark-tile"][value="tile"]') as HTMLInputElement
    await act(async () => { tile.click() })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tile: true }))

    const position = container.querySelector('select[name="t-watermark-position"]') as HTMLSelectElement
    await act(async () => {
      selectSetter.call(position, 'top-left')
      position.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ position: 'top-left' }))
  })

  it('切到 Logo 后读文件；控件里不混入按钮', async () => {
    const onChange = vi.fn()
    const onLogo = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <WatermarkControls
          idPrefix="t"
          options={{ ...DEFAULT_WATERMARK, kind: 'logo' }}
          logo={null}
          onChange={onChange}
          onLogo={onLogo}
        />,
      )
    })
    const file = new File(['png'], 'mark.png', { type: 'image/png' })
    const input = container.querySelector('input[aria-label="选择 Logo 图片"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onLogo).toHaveBeenCalledWith(file)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
