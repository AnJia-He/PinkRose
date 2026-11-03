// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPage } from './AccountPage'

vi.mock('../api/account', () => ({
  usage: vi.fn(async () => null),
  logout: vi.fn(async () => {}),
  changePassword: vi.fn(),
  changeUsername: vi.fn(),
  deleteAccount: vi.fn(),
}))
vi.mock('../api/memory', () => ({
  getMemoryProfile: vi.fn(async () => ({ enabled: false, summary: '' })),
  setMemoryEnabled: vi.fn(),
  clearMemoryProfile: vi.fn(),
}))
vi.mock('../api/models', () => ({
  listModels: vi.fn(async () => ({ configs: [] })),
}))

let container: HTMLElement
let root: Root

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const noop = async () => ({ synced: true })
  return act(async () => {
    root.render(
      <AccountPage
        user={{ id: 1, username: '测试用户', email: 'a@example.com' }}
        onGo={vi.fn()}
        onSignedOut={vi.fn()}
        onUserChanged={vi.fn()}
        defaultStyleId={null}
        styleOptions={[]}
        onDefaultStyleChange={noop}
        appearance="dark"
        onAppearanceChange={noop}
      />,
    )
  })
}

describe('桌面版文件保存位置', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'pinkroseDesktop', {
      configurable: true,
      writable: true,
      value: {
        isDesktop: true,
        platform: 'win32',
        getStorageInfo: vi.fn(async () => ({
          dataDir: 'D:\\PinkRoseData',
          platform: 'win32',
          version: '0.1.0',
        })),
        openStorageFolder: vi.fn(async () => ({ ok: true as const })),
        chooseStorageFolder: vi.fn(async () => ({ ok: true as const })),
      },
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as Window & { pinkroseDesktop?: unknown }).pinkroseDesktop
  })

  it('只在桌面桥存在时显示，并能打开或更改数据文件夹', async () => {
    await mount()
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('无需登录')
    expect(container.textContent).toContain('AI 与数据说明')
    expect(container.textContent).toContain('文件保存位置')
    expect(container.textContent).toContain('D:\\PinkRoseData')
    expect(container.textContent).toContain('未配置')
    expect(container.textContent).not.toContain('改密码')
    expect(container.textContent).not.toContain('注销账号')
    expect(container.querySelector('.account-signout')).toBeNull()

    const rows = [...container.querySelectorAll<HTMLButtonElement>('.account-storage-tile .account-row')]
    const open = rows.find(row => row.textContent?.includes('打开文件夹'))
    const change = rows.find(row => row.textContent?.includes('更改保存位置'))
    expect(open).toBeTruthy()
    expect(change).toBeTruthy()
    await act(async () => { open?.click() })
    await act(async () => { change?.click() })

    expect(window.pinkroseDesktop?.openStorageFolder).toHaveBeenCalledTimes(1)
    expect(window.pinkroseDesktop?.chooseStorageFolder).toHaveBeenCalledTimes(1)
  })
})
