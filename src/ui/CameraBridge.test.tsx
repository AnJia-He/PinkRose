// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CameraBridge from './CameraBridge.tsx'

let container: HTMLDivElement
let root: Root

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/app')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('相机文件夹桥', () => {
  it('连接后明确显示 RAW 与 HEIC / TIFF 的本机转换能力', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/camera/health')) {
        return json({
          ok: true, count: 0,
          converter: 'rawtherapee',
          converters: ['rawtherapee', 'sips'],
        })
      }
      if (url.includes('/api/camera/photos')) return json({ photos: [] })
      if (url.includes('/api/camera/control')) {
        return json({
          connected: false, model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    history.replaceState(
      null, '',
      '/app#camera=http%3A%2F%2F127.0.0.1%3A8788&token=test-token',
    )

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const capability = document.querySelector('[aria-label="RAW 转换能力"]')
    expect(capability?.textContent).toContain('完整 RAW：RawTherapee')
    expect(capability?.textContent).toContain('HEIC / TIFF：sips')
  })

  it('没有转换器时说明只会使用内嵌预览，并给出安装方向', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/camera/health')) {
        return json({ ok: true, count: 0, converter: null, converters: [] })
      }
      if (url.includes('/api/camera/photos')) return json({ photos: [] })
      if (url.includes('/api/camera/control')) {
        return json({
          connected: false, model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    history.replaceState(
      null, '',
      '/app#camera=http%3A%2F%2F127.0.0.1%3A8788&token=test-token',
    )

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const text = document.querySelector('[aria-label="RAW 转换能力"]')?.textContent ?? ''
    expect(text).toContain('完整 RAW：未找到转换器')
    expect(text).toContain('RAW 仅使用相机内嵌预览')
    expect(text).toContain('安装 RawTherapee、darktable 或 LibRaw')
  })

  it('相机掉线后状态会随轮询刷新，不一直显示旧的已连接机型', async () => {
    let controlCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.includes('/api/camera/photos')) return json({ photos: [] })
      if (url.includes('/api/camera/control')) {
        controlCalls++
        return json(controlCalls === 1
          ? {
            connected: true,
            model: 'Canon EOS R5',
            capabilities: { liveView: true, shutter: true, settings: false },
          }
          : {
            connected: false,
            model: null,
            capabilities: { liveView: false, shutter: false, settings: false },
            diagnostic: '相机连接断开了。检查 USB / Wi-Fi 后重新连接。',
          })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Canon EOS R5')

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2200))
    })
    expect(controlCalls).toBeGreaterThan(1)
    expect(document.body.textContent).toContain('未检测到相机')
    expect(document.body.textContent).toContain('相机连接断开了')
  })

  it('★ 配对链接打开后自动填好地址 / 令牌并连接，随即清掉 hash', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.includes('/api/camera/photos')) return json({ photos: [] })
      if (url.includes('/api/camera/control')) {
        return json({
          connected: false, model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    history.replaceState(
      null, '',
      '/app#camera=http%3A%2F%2F192.168.1.8%3A8788&token=secret-token',
    )

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(calls.some(url => url.includes('192.168.1.8:8788/api/camera/health')))
      .toBe(true)
    expect((document.querySelector('[aria-label="相机桥地址"]') as HTMLInputElement).value)
      .toBe('http://192.168.1.8:8788')
    expect((document.querySelector('[aria-label="相机桥访问令牌"]') as HTMLInputElement).value)
      .toBe('secret-token')
    expect(location.hash).toBe('')
  })

  it('★ 复制配对链接：局域网地址 + 网页端口，提示含令牌', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const address = document.querySelector('[aria-label="相机桥地址"]') as HTMLInputElement
    const token = document.querySelector('[aria-label="相机桥访问令牌"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(address, 'http://192.168.1.8:8788')
      address.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(token, 'secret-token')
      token.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const copy = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '复制配对链接')!
    expect(copy).toBeTruthy()
    await act(async () => {
      copy.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const link = String(writeText.mock.calls[0]?.[0])
    const url = new URL(link)
    expect(url.hostname).toBe('192.168.1.8')
    expect(url.port).toBe('3000')
    expect(url.hash).toContain('secret-token')
    expect(document.body.textContent).toContain('含访问令牌')
  })

  it('连接后列出照片，导入时把原文件交给上层', async () => {
    const onImport = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 2 })
      if (url.endsWith('/api/camera/photos')) {
        return json({
          photos: [
            {
              id: 'day/a.jpg', name: 'a.jpg', folder: 'day', size: 2048, mtime: 0,
              type: 'image/jpeg', url: '/api/camera/file?id=day%2Fa.jpg',
              sidecar: {
                id: 'day/a.xmp', name: 'a.xmp', size: 8, mtime: 0,
                type: 'application/rdf+xml', url: '/api/camera/file?id=day%2Fa.xmp',
              },
            },
            {
              id: 'b.heic', name: 'b.heic', size: 4096, mtime: 0,
              type: 'image/heic', url: '/api/camera/file?id=b.heic',
            },
          ],
        })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={onImport} />)
    })
    expect(document.body.textContent).toContain('相机桥')
    expect(document.body.textContent).toContain('连接后')

    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('已连接 · 2 张')
    expect(document.body.textContent).toContain('a.jpg')
    expect(document.body.textContent).toContain('XMP')
    expect(document.body.textContent).toContain('day ·')
    expect(document.body.textContent).toContain('b.heic')

    const importButton = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导入')!
    await act(async () => {
      importButton.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport).toHaveBeenCalledTimes(1)
    const file = onImport.mock.calls[0]![0] as File
    const sidecar = onImport.mock.calls[0]![1] as File
    expect(file.name).toBe('a.jpg')
    expect(file.type).toBe('image/jpeg')
    expect(file.size).toBe(3)
    expect(sidecar.name).toBe('a.xmp')
    expect(sidecar.type).toBe('application/rdf+xml')
  })

  it('桥没启动时给一句能照着做的提示，不把弹层带走', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect failed')
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('npm run camera:bridge')
    expect(document.body.textContent).toContain('再试一次')
  })

  it('★ 跨设备访问令牌会带到健康检查、轮询和图片 URL，并记住这台浏览器', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url, headers })
      if (url.includes('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.includes('/api/camera/photos')) {
        return json({
          photos: [{
            id: 'ipad.jpg', name: 'ipad.jpg', size: 3, mtime: 0,
            type: 'image/jpeg', url: '/api/camera/file?id=ipad.jpg',
          }],
        })
      }
      if (url.includes('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const tokenInput = document.querySelector(
      'input[aria-label="相机桥访问令牌"]',
    ) as HTMLInputElement
    expect(tokenInput).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(tokenInput, 'secret-token')
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const health = calls.find(call => call.url.includes('/api/camera/health'))!
    expect(health.url).toContain('token=secret-token')
    expect(health.headers['x-pinkrose-bridge-token']).toBe('secret-token')
    expect(localStorage.getItem('pinkrose.camera.bridge.token')).toBe('secret-token')

    const importButton = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导入')!
    await act(async () => {
      importButton.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const file = calls.find(call => call.url.includes('/api/camera/file'))!
    expect(file.url).toContain('token=secret-token')
    expect(file.headers['x-pinkrose-bridge-token']).toBe('secret-token')
  })

  it('打开自动导入后，轮询到的新照片会自动进入修图', async () => {
    const onImport = vi.fn()
    let photoCalls = 0
    const a = {
      id: 'a.jpg', name: 'a.jpg', size: 3, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=a.jpg',
    }
    const b = {
      id: 'b.jpg', name: 'b.jpg', size: 3, mtime: 2,
      type: 'image/jpeg', url: '/api/camera/file?id=b.jpg',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({ photos: photoCalls === 1 ? [a] : [b, a] })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={onImport} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport).not.toHaveBeenCalled()

    const auto = document.querySelector('input[aria-label="自动导入新照片"]') as HTMLInputElement
    await act(async () => { auto.click() })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2200))
    })

    expect(onImport).toHaveBeenCalledTimes(1)
    const file = onImport.mock.calls[0]![0] as File
    expect(file.name).toBe('b.jpg')
    expect(file.type).toBe('image/jpeg')
    expect(file.size).toBe(3)
  })

  it('自动导入偏好会记住；关掉后不再自动导入', async () => {
    localStorage.setItem('pinkrose.camera.bridge.autoImport', '1')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/photos')) {
        return json({ photos: [{
          id: 'a.jpg', name: 'a.jpg', size: 3, mtime: 1,
          type: 'image/jpeg', url: '/api/camera/file?id=a.jpg',
        }] })
      }
      if (url.endsWith('/api/camera/control')) {
        return json({ connected: false, model: null, capabilities: {
          liveView: false, shutter: false, settings: false,
        } })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const auto = document.querySelector('input[aria-label="自动导入新照片"]') as HTMLInputElement
    expect(auto.checked, '上次打开的自动导入要恢复').toBe(true)
    await act(async () => { auto.click() })
    expect(localStorage.getItem('pinkrose.camera.bridge.autoImport')).toBeNull()
  })

  it('★ 同时到了多张新照片：一起交给批量处理，不只取最新一张', async () => {
    const onImport = vi.fn()
    const onImportMany = vi.fn()
    let photoCalls = 0
    const a = { id: 'a.jpg', name: 'a.jpg', size: 3, mtime: 1, type: 'image/jpeg', url: '/api/camera/file?id=a.jpg' }
    const b = { id: 'b.jpg', name: 'b.jpg', size: 3, mtime: 2, type: 'image/jpeg', url: '/api/camera/file?id=b.jpg' }
    const c = { id: 'c.jpg', name: 'c.jpg', size: 3, mtime: 3, type: 'image/jpeg', url: '/api/camera/file?id=c.jpg' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({ connected: false, model: null, capabilities: {
          liveView: false, shutter: false, settings: false,
        } })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({ photos: photoCalls === 1 ? [a] : [c, b, a] })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge
        open onClose={() => {}} onImport={onImport} onImportMany={onImportMany}
      />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const auto = document.querySelector('input[aria-label="自动导入新照片"]') as HTMLInputElement
    await act(async () => { auto.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)) })

    expect(onImport).not.toHaveBeenCalled()
    expect(onImportMany).toHaveBeenCalledTimes(1)
    const files = onImportMany.mock.calls[0]![0] as File[]
    expect(files.map(file => file.name).sort()).toEqual(['b.jpg', 'c.jpg'])
    expect(files.every(file => file.type === 'image/jpeg')).toBe(true)
  })

  it('★ 列表里的「导入全部」把整组照片交给批量处理', async () => {
    const onImportMany = vi.fn()
    const a = {
      id: 'a.jpg', name: 'a.jpg', size: 3, mtime: 2, type: 'image/jpeg',
      url: '/api/camera/file?id=a.jpg',
      sidecar: {
        id: 'a.xmp', name: 'a.xmp', size: 8, mtime: 2, type: 'application/rdf+xml',
        url: '/api/camera/file?id=a.xmp',
      },
    }
    const b = { id: 'b.jpg', name: 'b.jpg', size: 3, mtime: 1, type: 'image/jpeg', url: '/api/camera/file?id=b.jpg' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 2 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [a, b] })
      if (url.endsWith('/api/camera/control')) {
        return json({ connected: false, model: null, capabilities: {
          liveView: false, shutter: false, settings: false,
        } })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} onImportMany={onImportMany} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const all = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导入全部')!
    expect(all).toBeTruthy()
    await act(async () => {
      all.click()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(onImportMany).toHaveBeenCalledTimes(1)
    expect((onImportMany.mock.calls[0]![0] as File[]).map(file => file.name))
      .toEqual(['a.jpg', 'b.jpg'])
    expect((onImportMany.mock.calls[0]![1] as File[]).map(file => file.name))
      .toEqual(['a.xmp'])
  })

  it('★ RAW / HEIC 有转换器时，「导入」默认取 JPG；「原图」仍取原始文件', async () => {
    const onImport = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/photos')) {
        return json({
          photos: [{
            id: 'shot.cr3', name: 'shot.cr3', size: 9000, mtime: 0,
            type: 'image/x-canon-cr3', url: '/api/camera/file?id=shot.cr3',
            convertUrl: '/api/camera/convert?id=shot.cr3',
          }],
        })
      }
      if (url.includes('/api/camera/convert')) {
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      if (url.includes('/api/camera/file')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/x-canon-cr3' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={onImport} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const original = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '原图')!
    const primary = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导入 JPG')!
    expect(original).toBeTruthy()
    expect(primary).toBeTruthy()
    await act(async () => {
      primary.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport).toHaveBeenCalledTimes(1)
    const converted = onImport.mock.calls[0]![0] as File
    expect(converted.name).toBe('shot.jpg')
    expect(converted.type).toBe('image/jpeg')
    expect(converted.size).toBe(4)

    await act(async () => {
      original.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport).toHaveBeenCalledTimes(2)
    const file = onImport.mock.calls[1]![0] as File
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes('/api/camera/file?id=shot.cr3'))).toBe(true)
    expect(file.name).toBe('shot.cr3')
    expect(file.type).toBe('image/x-canon-cr3')
    expect(file.size).toBe(4)
  })

  it('★ RAW+JPEG 配对：列表只一条，默认导入 JPG，RAW 按钮取原片', async () => {
    const onImport = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/photos')) {
        return json({
          photos: [{
            id: 'IMG_0001.JPG', name: 'IMG_0001.JPG', size: 1200, mtime: 1000,
            type: 'image/jpeg', url: '/api/camera/file?id=IMG_0001.JPG',
            convertUrl: null,
            raw: {
              id: 'IMG_0001.CR3', name: 'IMG_0001.CR3', size: 9000, mtime: 1000,
              type: 'image/x-canon-cr3',
              url: '/api/camera/file?id=IMG_0001.CR3',
              convertUrl: null,
            },
          }],
        })
      }
      if (url.includes('id=IMG_0001.JPG')) {
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      if (url.includes('id=IMG_0001.CR3')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/x-canon-cr3' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={onImport} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.querySelectorAll('.bridge-photo')).toHaveLength(1)
    expect(document.body.textContent).toContain('JPG + RAW')
    const primary = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导入')!
    const raw = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'RAW')!
    expect(primary).toBeTruthy()
    expect(raw).toBeTruthy()
    await act(async () => {
      primary.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport.mock.calls[0]![0]).toMatchObject({
      name: 'IMG_0001.JPG', type: 'image/jpeg',
    })
    await act(async () => {
      raw.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onImport.mock.calls[1]![0]).toMatchObject({
      name: 'IMG_0001.CR3', type: 'image/x-canon-cr3',
    })
  })

  it('可控相机显示实时取景和快门；按下后刷新照片列表', async () => {
    let photoCalls = 0
    const basePhoto = {
      id: 'one.jpg', name: 'one.jpg', size: 1000, mtime: 0,
      type: 'image/jpeg', url: '/api/camera/file?id=one.jpg',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Mock Camera',
          capabilities: { liveView: true, shutter: true, settings: false },
        })
      }
      if (url.endsWith('/api/camera/shutter')) {
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>)['x-pinkrose-camera']).toBe('1')
        return json({ ok: true, result: { saved: 'capture-1.jpg' } })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({
          photos: photoCalls === 1
            ? [basePhoto]
            : [
              {
                ...basePhoto, id: 'capture-1.jpg', name: 'capture-1.jpg',
                url: '/api/camera/file?id=capture-1.jpg',
              },
              basePhoto,
            ],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Mock Camera')
    const live = document.querySelector('.bridge-live .camera-live-view') as HTMLElement
    expect(live).toBeTruthy()
    expect(live.textContent).toContain('网格')
    expect(live.textContent).toContain('对焦峰值')
    expect(live.textContent).toContain('斑马纹')
    expect(live.textContent).toContain('直方图')
    expect(live.textContent).toContain('伪色')
    expect(live.textContent).toContain('2×')
    expect(live.textContent).toContain('4×')
    const loupe = live.querySelector('[aria-label="100% 对焦放大镜"]') as HTMLButtonElement
    expect(loupe).toBeTruthy()
    expect(loupe.getAttribute('aria-pressed')).toBe('false')
    await act(async () => { loupe.click() })
    expect(loupe.getAttribute('aria-pressed')).toBe('true')
    expect(live.querySelector('.camera-loupe canvas')).toBeTruthy()
    const frame = live.querySelector('.camera-live-frame') as HTMLElement
    const fullscreen = live.querySelector('[aria-label="全屏取景"]') as HTMLButtonElement
    expect(fullscreen).toBeTruthy()
    await act(async () => { fullscreen.click() })
    expect(frame.classList.contains('expanded')).toBe(true)
    expect(live.querySelector('[aria-label="退出全屏取景"]')).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(frame.classList.contains('expanded')).toBe(false)

    const shutter = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '拍一张')!
    await act(async () => {
      shutter.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('capture-1.jpg')
    expect(photoCalls).toBe(2)
  })

  it('实时取景失败时把相机面板里的具体原因显示出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Canon EOS R5',
          capabilities: { liveView: true, shutter: true, settings: false },
          previewDiagnostic: '实时取景被别的程序占用。关掉 EOS Utility 后再试。',
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('实时取景被别的程序占用')
  })

  it('打开自动导入后，按快门立即把新照片交给上层', async () => {
    const onImport = vi.fn()
    let photoCalls = 0
    const basePhoto = {
      id: 'one.jpg', name: 'one.jpg', size: 1000, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=one.jpg',
    }
    const captured = {
      id: 'capture-2.jpg', name: 'capture-2.jpg', size: 3, mtime: 2,
      type: 'image/jpeg', url: '/api/camera/file?id=capture-2.jpg',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Mock Camera',
          capabilities: { liveView: true, shutter: true, settings: false },
        })
      }
      if (url.endsWith('/api/camera/shutter')) {
        expect(init?.method).toBe('POST')
        return json({ ok: true, result: { saved: 'capture-2.jpg' } })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({ photos: photoCalls === 1 ? [basePhoto] : [captured, basePhoto] })
      }
      if (url.includes('/api/camera/file?id=capture-2.jpg')) {
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={onImport} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const auto = document.querySelector('input[aria-label="自动导入新照片"]') as HTMLInputElement
    await act(async () => { auto.click() })
    const shutter = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '拍一张')!
    await act(async () => {
      shutter.click()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(onImport).toHaveBeenCalledTimes(1)
    const file = onImport.mock.calls[0]![0] as File
    expect(file.name).toBe('capture-2.jpg')
    expect(file.type).toBe('image/jpeg')
    expect(file.size).toBe(3)
  })

  it('★ 相机支持时，可从存储卡导入最近照片并整组交给批量处理', async () => {
    const onImportMany = vi.fn()
    const photoA = {
      id: 'IMG_0001.JPG', name: 'IMG_0001.JPG', size: 3, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=IMG_0001.JPG',
    }
    const photoB = {
      id: 'IMG_0002.JPG', name: 'IMG_0002.JPG', size: 3, mtime: 2,
      type: 'image/jpeg', url: '/api/camera/file?id=IMG_0002.JPG',
    }
    let imported = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Canon EOS R7',
          capabilities: { liveView: false, shutter: true, settings: false, import: true },
        })
      }
      if (url.endsWith('/api/camera/photos')) {
        return json({ photos: imported ? [photoB, photoA] : [] })
      }
      if (url.endsWith('/api/camera/import')) {
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>)['x-pinkrose-camera']).toBe('1')
        expect(JSON.parse(String(init?.body))).toEqual({ limit: 20 })
        imported = true
        return json({ ok: true, result: { imported: ['IMG_0001.JPG', 'IMG_0002.JPG'] } })
      }
      if (url.includes('/api/camera/file?id=IMG_000')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(
        <CameraBridge open onClose={() => {}} onImport={() => {}} onImportMany={onImportMany} />,
      )
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const importButton = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '从相机导入')!
    expect(importButton).toBeTruthy()
    await act(async () => {
      importButton.click()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(onImportMany).toHaveBeenCalledTimes(1)
    expect((onImportMany.mock.calls[0]![0] as File[]).map(file => file.name))
      .toEqual(['IMG_0002.JPG', 'IMG_0001.JPG'])
  })

  it('间隔拍摄连续按两次快门，结束后把整组新照片交给批量入口', async () => {
    const onImport = vi.fn()
    const onImportMany = vi.fn()
    let shutterCalls = 0
    let photoCalls = 0
    const one = {
      id: 'one.jpg', name: 'one.jpg', size: 3, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=one.jpg',
    }
    const two = {
      id: 'two.jpg', name: 'two.jpg', size: 3, mtime: 2,
      type: 'image/jpeg', url: '/api/camera/file?id=two.jpg',
    }
    const three = {
      id: 'three.jpg', name: 'three.jpg', size: 3, mtime: 3,
      type: 'image/jpeg', url: '/api/camera/file?id=three.jpg',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Mock Camera',
          capabilities: { liveView: false, shutter: true, settings: false },
        })
      }
      if (url.endsWith('/api/camera/shutter')) {
        shutterCalls++
        return json({ ok: true, result: { saved: shutterCalls === 1 ? 'two.jpg' : 'three.jpg' } })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({
          photos: photoCalls === 1
            ? [one]
            : photoCalls === 2 ? [two, one] : [three, two, one],
        })
      }
      if (url.includes('/api/camera/file?id=')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(<CameraBridge
        open onClose={() => {}} onImport={onImport} onImportMany={onImportMany}
      />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const auto = document.querySelector('input[aria-label="自动导入新照片"]') as HTMLInputElement
    await act(async () => { auto.click() })
    const count = document.querySelector('input[aria-label="间隔拍摄张数"]') as HTMLInputElement
    const seconds = document.querySelector('input[aria-label="间隔拍摄秒数"]') as HTMLInputElement
    expect(count).toBeTruthy()
    expect(seconds).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(count, '2')
      count.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(seconds, '1')
      seconds.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const run = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '间隔拍摄')!
    await act(async () => {
      run.click()
      await new Promise(resolve => setTimeout(resolve, 1200))
    })

    expect(shutterCalls).toBe(2)
    expect(onImport).not.toHaveBeenCalled()
    expect(onImportMany).toHaveBeenCalledTimes(1)
    expect((onImportMany.mock.calls[0]![0] as File[]).map(file => file.name))
      .toEqual(['three.jpg', 'two.jpg'])
  })

  it('间隔拍摄可以中途停止，不再触发下一张', async () => {
    let shutterCalls = 0
    let photoCalls = 0
    const one = {
      id: 'one.jpg', name: 'one.jpg', size: 3, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=one.jpg',
    }
    const two = {
      id: 'two.jpg', name: 'two.jpg', size: 3, mtime: 2,
      type: 'image/jpeg', url: '/api/camera/file?id=two.jpg',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Mock Camera',
          capabilities: { liveView: false, shutter: true, settings: false },
        })
      }
      if (url.endsWith('/api/camera/shutter')) {
        shutterCalls++
        return json({ ok: true, result: { saved: 'two.jpg' } })
      }
      if (url.endsWith('/api/camera/photos')) {
        photoCalls++
        return json({ photos: photoCalls === 1 ? [one] : [two, one] })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const count = document.querySelector('input[aria-label="间隔拍摄张数"]') as HTMLInputElement
    const seconds = document.querySelector('input[aria-label="间隔拍摄秒数"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(count, '3')
      count.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(seconds, '1')
      seconds.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const run = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '间隔拍摄')!
    await act(async () => {
      run.click()
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    const stop = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim().startsWith('停止 '))!
    expect(stop).toBeTruthy()
    await act(async () => {
      stop.click()
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    expect(shutterCalls).toBe(1)
    expect(document.body.textContent).toContain('间隔拍摄已停止')
  })

  it('包围曝光按 -1 / 0 / +1 EV 拍摄，结束后恢复原曝光', async () => {
    const onHdrMany = vi.fn()
    let shutterCalls = 0
    let currentExposure = 0
    const exposurePuts: number[] = []
    const basePhoto = {
      id: 'base.jpg', name: 'base.jpg', size: 3, mtime: 1,
      type: 'image/jpeg', url: '/api/camera/file?id=base.jpg',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 1 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Bracket Camera',
          capabilities: { liveView: false, shutter: true, settings: true },
          settingsSchema: [{
            key: 'exposureCompensation', label: '曝光补偿',
            type: 'number', min: -1, max: 1, step: 1,
          }],
        })
      }
      if (url.endsWith('/api/camera/settings')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { exposureCompensation: number }
          currentExposure = body.exposureCompensation
          exposurePuts.push(currentExposure)
        }
        return json({ settings: { exposureCompensation: currentExposure } })
      }
      if (url.endsWith('/api/camera/shutter')) {
        shutterCalls++
        return json({ ok: true, result: { saved: `shot-${shutterCalls}.jpg` } })
      }
      if (url.endsWith('/api/camera/photos')) {
        return json({
          photos: [
            ...Array.from({ length: shutterCalls }, (_, i) => ({
              id: `shot-${i + 1}.jpg`,
              name: `shot-${i + 1}.jpg`,
              size: 3,
              mtime: i + 2,
              type: 'image/jpeg',
              url: `/api/camera/file?id=shot-${i + 1}.jpg`,
            })),
            basePhoto,
          ],
        })
      }
      if (url.includes('/api/camera/file?')) {
        return new Response('photo', {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(
        <CameraBridge
          open
          onClose={() => {}}
          onImport={() => {}}
          onHdrMany={onHdrMany}
        />,
      )
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const shots = document.querySelector('input[aria-label="包围曝光张数"]') as HTMLInputElement | null
    const select = shots ?? document.querySelector('select[aria-label="包围曝光张数"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const step = document.querySelector('select[aria-label="包围曝光步长"]') as HTMLSelectElement
    expect(step).toBeTruthy()
    const run = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '包围曝光')!
    expect(run).toBeTruthy()
    await act(async () => {
      run.click()
      await new Promise(resolve => setTimeout(resolve, 350))
    })

    expect(shutterCalls).toBe(3)
    expect(exposurePuts).toEqual([-1, 0, 1, 0])
    expect(document.body.textContent).toContain('包围曝光')
    const hdr = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '用这组做 HDR')!
    expect(hdr).toBeTruthy()
    await act(async () => {
      hdr.click()
      await new Promise(resolve => setTimeout(resolve, 40))
    })
    expect(onHdrMany).toHaveBeenCalledTimes(1)
    expect((onHdrMany.mock.calls[0]![0] as File[]).map(file => file.name))
      .toEqual(['shot-1.jpg', 'shot-2.jpg', 'shot-3.jpg'])
  })

  it('★ 相机暴露可写焦点时，焦点包围拍 3 张并直接交给焦点堆栈', async () => {
    const onFocusMany = vi.fn()
    let shutterCalls = 0
    let currentFocus = 50
    const focusPuts: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Focus Camera',
          capabilities: { liveView: false, shutter: true, settings: true },
          settingsSchema: [
            {
              key: 'focusMode', label: '对焦模式', type: 'select',
              options: [{ value: 'MF', label: 'MF' }, { value: 'AF', label: 'AF' }],
            },
            {
              key: 'manualfocusdrive', label: '手动对焦位置',
              type: 'number', min: 0, max: 100, step: 1,
            },
          ],
        })
      }
      if (url.endsWith('/api/camera/settings')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { manualfocusdrive: number }
          currentFocus = body.manualfocusdrive
          focusPuts.push(currentFocus)
        }
        return json({ settings: { focusMode: 'MF', manualfocusdrive: currentFocus } })
      }
      if (url.endsWith('/api/camera/shutter')) {
        shutterCalls++
        return json({ ok: true, result: { saved: `focus-${shutterCalls}.jpg` } })
      }
      if (url.endsWith('/api/camera/photos')) {
        return json({
          photos: Array.from({ length: shutterCalls }, (_, i) => ({
            id: `focus-${i + 1}.jpg`,
            name: `focus-${i + 1}.jpg`,
            size: 3,
            mtime: i + 1,
            type: 'image/jpeg',
            url: `/api/camera/file?id=focus-${i + 1}.jpg`,
          })),
        })
      }
      if (url.includes('/api/camera/file?')) {
        return new Response('photo', {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }))

    await act(async () => {
      root.render(
        <CameraBridge
          open
          onClose={() => {}}
          onImport={() => {}}
          onFocusMany={onFocusMany}
        />,
      )
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const run = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '焦点包围')!
    expect(run).toBeTruthy()
    await act(async () => {
      run.click()
      await new Promise(resolve => setTimeout(resolve, 350))
    })

    expect(shutterCalls).toBe(3)
    expect(focusPuts).toEqual([45, 50, 55, 50])
    const stack = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '用这组做焦点堆栈')!
    expect(stack).toBeTruthy()
    await act(async () => {
      stack.click()
      await new Promise(resolve => setTimeout(resolve, 40))
    })
    expect(onFocusMany).toHaveBeenCalledTimes(1)
    expect((onFocusMany.mock.calls[0]![0] as File[]).map(file => file.name))
      .toEqual(['focus-1.jpg', 'focus-2.jpg', 'focus-3.jpg'])
  })

  it('gphoto2 桥连着但没插相机时，状态说清楚', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
          diagnostic: 'gphoto2 已运行，但没检测到相机。检查相机电源和 USB 连接。',
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('未检测到相机')
    expect(document.body.textContent).toContain('检查相机电源和 USB 连接')
  })

  it('★ 没有先开 gphoto2 时，可以在网页里输入相机 IP 连接无线 PTP/IP', async () => {
    let putBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/provider')) {
        expect(init?.method).toBe('PUT')
        expect((init?.headers as Record<string, string>)['x-pinkrose-camera']).toBe('1')
        putBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({
          ok: true,
          control: {
            connected: true,
            model: 'Canon EOS R5',
            capabilities: { liveView: true, shutter: true, settings: false },
            canConfigure: true,
          },
        })
      }
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
          canConfigure: true,
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const ip = document.querySelector('[aria-label="相机 Wi-Fi IP"]') as HTMLInputElement
    expect(ip).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(ip, '192.168.1.50')
      ip.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const wireless = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '连接无线相机')!
    await act(async () => {
      wireless.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(putBody).toEqual({
      kind: 'gphoto2', ip: '192.168.1.50', port: '',
    })
    expect(document.body.textContent).toContain('Canon EOS R5')
    expect(document.body.textContent).toContain('已连接无线相机')
  })

  it('★ 网页可直接切换到 Canon CCAPI，并把地址热配置给桥', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/provider')) {
        expect(init?.method).toBe('PUT')
        expect((init?.headers as Record<string, string>)['x-pinkrose-camera']).toBe('1')
        putBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({
          ok: true,
          control: {
            connected: true,
            model: 'Canon EOS R7',
            capabilities: { liveView: true, shutter: true, settings: false },
            canConfigure: true,
          },
        })
      }
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
          canConfigure: true,
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const mode = document.querySelector('[aria-label="无线相机连接方式"]') as HTMLSelectElement
    expect(mode).toBeTruthy()
    await act(async () => {
      mode.value = 'canon-ccapi'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const ip = document.querySelector('[aria-label="Canon CCAPI 地址"]') as HTMLInputElement
    const port = document.querySelector('[aria-label="相机端口"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(ip, '192.168.1.60')
      ip.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(port, '8080')
      port.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const wireless = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '连接无线相机')!
    await act(async () => {
      wireless.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(putBody).toEqual({
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })
    expect(document.body.textContent).toContain('Canon EOS R7')
    expect(document.body.textContent).toContain('已连接 Canon CCAPI')
  })

  it('★ 网页可切换到 Sony Camera Remote，并补默认 10000 端口', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/provider')) {
        putBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({
          ok: true,
          control: {
            connected: true,
            model: 'Sony Alpha 7C',
            capabilities: { liveView: true, shutter: true, settings: false },
            canConfigure: true,
          },
        })
      }
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
          canConfigure: true,
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const mode = document.querySelector('[aria-label="无线相机连接方式"]') as HTMLSelectElement
    await act(async () => {
      mode.value = 'sony-camera'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const address = document.querySelector('[aria-label="Sony Camera Remote 地址"]') as HTMLInputElement
    expect(address).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(address, '192.168.1.70')
      address.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const wireless = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '连接无线相机')!
    await act(async () => {
      wireless.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(putBody).toEqual({
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })
    expect(document.body.textContent).toContain('Sony Alpha 7C')
    expect(document.body.textContent).toContain('已连接 Sony Camera Remote')
  })

  it('可控相机按适配器描述渲染参数，并把修改 PUT 回桥', async () => {
    let saved: Record<string, string | number> = { iso: 400, shutter: '1/125' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Mock Camera',
          capabilities: { liveView: false, shutter: false, settings: true },
          settingsSchema: [
            { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 6400, step: 100 },
            {
              key: 'shutter', label: '快门', type: 'select',
              options: [
                { value: '1/125', label: '1/125' },
                { value: '1/250', label: '1/250' },
              ],
            },
          ],
        })
      }
      if (url.endsWith('/api/camera/settings')) {
        if (init?.method === 'PUT') {
          expect((init.headers as Record<string, string>)['x-pinkrose-camera']).toBe('1')
          saved = { ...saved, ...JSON.parse(String(init.body)) as Record<string, string | number> }
        }
        return json({ settings: saved })
      }
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const iso = document.querySelector('input[aria-label="ISO"]') as HTMLInputElement
    const shutter = document.querySelector('select[aria-label="快门"]') as HTMLSelectElement
    expect(iso.value).toBe('400')
    expect(shutter.value).toBe('1/125')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(iso, '800')
      iso.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(shutter, '1/250')
      shutter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const apply = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '应用参数')!
    await act(async () => {
      apply.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(saved).toMatchObject({ iso: 800, shutter: '1/250' })

    const presetName = document.querySelector('input[aria-label="拍摄参数预设名称"]') as HTMLInputElement
    await act(async () => {
      setter.call(presetName, '棚拍')
      presetName.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const savePreset = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '存为我的参数')!
    await act(async () => { savePreset.click() })
    const presetSelect = document.querySelector('select[aria-label="拍摄参数预设"]') as HTMLSelectElement
    expect(presetSelect).toBeTruthy()
    expect(presetSelect.value).not.toBe('')

    // 把当前值改乱，再套回快照；PUT 应该恢复 800 / 1/250。
    await act(async () => {
      setter.call(iso, '1600')
      iso.dispatchEvent(new Event('input', { bubbles: true }))
      selectSetter.call(shutter, '1/125')
      shutter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const applyPreset = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '套用预设')!
    await act(async () => {
      applyPreset.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(saved).toMatchObject({ iso: 800, shutter: '1/250' })
    expect(document.body.textContent).toContain('已套用 2 项参数')

    const removePreset = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '删除预设')!
    await act(async () => { removePreset.click() })
    expect(document.querySelector('select[aria-label="拍摄参数预设"]')).toBeNull()
  })

  it('gphoto2 动态 ISO 选项：当前值对得上下拉框，改完原样 PUT 回桥', async () => {
    let saved: Record<string, string | number> = { iso: 400 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Canon EOS R5',
          capabilities: { liveView: false, shutter: false, settings: true },
          settingsSchema: [{
            key: 'iso', label: 'ISO', type: 'select',
            options: ['100', '200', '400', '800'].map(value => ({ value, label: value })),
          }],
        })
      }
      if (url.endsWith('/api/camera/settings')) {
        if (init?.method === 'PUT') {
          saved = { ...saved, ...JSON.parse(String(init.body)) as Record<string, string> }
        }
        return json({ settings: saved })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const iso = document.querySelector('select[aria-label="ISO"]') as HTMLSelectElement
    expect(iso.value).toBe('400')
    expect([...iso.options].map(option => option.value)).toEqual(['100', '200', '400', '800'])

    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(iso, '800')
      iso.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const apply = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '应用参数')!
    await act(async () => {
      apply.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(saved.iso).toBe('800')
  })

  it('电池 / 镜头作为只读状态显示，不会写回相机', async () => {
    let putBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/camera/health')) return json({ ok: true, count: 0 })
      if (url.endsWith('/api/camera/photos')) return json({ photos: [] })
      if (url.endsWith('/api/camera/control')) {
        return json({
          connected: true,
          model: 'Canon EOS R5',
          capabilities: { liveView: false, shutter: false, settings: true },
          settingsSchema: [
            { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 800, step: 100 },
            { key: 'battery', label: '电池', type: 'number', min: 0, max: 100, step: 1, readOnly: true },
            {
              key: 'lens', label: '镜头', type: 'select', readOnly: true,
              options: [{ value: 'RF24-70mm F2.8', label: 'RF24-70mm F2.8' }],
            },
          ],
        })
      }
      if (url.endsWith('/api/camera/settings')) {
        if (init?.method === 'PUT') putBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return json({ settings: { iso: 400, battery: 75, lens: 'RF24-70mm F2.8' } })
      }
      throw new Error(`unexpected ${url}`)
    }))
    await act(async () => {
      root.render(<CameraBridge open onClose={() => {}} onImport={() => {}} />)
    })
    const connect = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('连接'))!
    await act(async () => {
      connect.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const battery = document.querySelector('input[aria-label="电池"]') as HTMLInputElement
    const lens = document.querySelector('select[aria-label="镜头"]') as HTMLSelectElement
    expect(battery.disabled).toBe(true)
    expect(lens.disabled).toBe(true)
    expect(battery.value).toBe('75')
    expect(lens.value).toBe('RF24-70mm F2.8')

    const apply = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '应用参数')!
    await act(async () => {
      apply.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(putBody).toMatchObject({ iso: 400 })
    expect(putBody).not.toHaveProperty('battery')
    expect(putBody).not.toHaveProperty('lens')
  })
})
