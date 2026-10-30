// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useNetworkStatus } from './useNetworkStatus'

let root: Root | null = null
let container: HTMLDivElement | null = null
const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')

function setOnline(value: boolean) {
  Object.defineProperty(Navigator.prototype, 'onLine', {
    configurable: true,
    get: () => value,
  })
  window.dispatchEvent(new Event(value ? 'online' : 'offline'))
}

function Probe() {
  return <span>{useNetworkStatus() ? '在线' : '离线'}</span>
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  return container
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  if (original) Object.defineProperty(Navigator.prototype, 'onLine', original)
})

describe('网络状态', () => {
  it('读取当前状态，并响应 online / offline 事件', async () => {
    Object.defineProperty(Navigator.prototype, 'onLine', {
      configurable: true,
      get: () => true,
    })
    const el = await mount()
    expect(el.textContent).toBe('在线')
    await act(async () => setOnline(false))
    expect(el.textContent).toBe('离线')
    await act(async () => setOnline(true))
    expect(el.textContent).toBe('在线')
  })

  it('首次打开就离线时不会误报在线', async () => {
    Object.defineProperty(Navigator.prototype, 'onLine', {
      configurable: true,
      get: () => false,
    })
    const el = await mount()
    expect(el.textContent).toBe('离线')
  })
})
