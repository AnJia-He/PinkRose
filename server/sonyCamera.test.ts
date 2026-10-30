import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSonyCameraProvider } from './sonyCamera.ts'
import { sonyCameraBaseUrl } from './sonyCameraUrl.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x53, 0x4f, 0x4e, 0x59, 0xff, 0xd9])

let root = ''
let server: ReturnType<typeof createServer> | null = null
let base = ''
let iso = '400'
let startRecCalls = 0
let cameraFunction = 'Remote Shooting'

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function liveFrame(): Buffer {
  const header = Buffer.alloc(136)
  header[0] = 0xff
  header[1] = 1
  header.writeUInt32BE(0x24356879, 8)
  header[12] = 0
  header[13] = 0
  header[14] = JPEG.length
  header[15] = 0
  return Buffer.concat([header, JPEG])
}

async function fakeSony(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', base || 'http://127.0.0.1')
  if (url.pathname === '/liveview' && request.method === 'GET') {
    const body = liveFrame()
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
    })
    response.end(body)
    return
  }
  if (url.pathname === '/photo.jpg' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': JPEG.length,
    })
    response.end(JPEG)
    return
  }
  if (url.pathname === '/DSC0001.JPG' || url.pathname === '/DSC0002.JPG') {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': JPEG.length,
    })
    response.end(JPEG)
    return
  }
  if (!['/sony/camera', '/sony/avContent'].includes(url.pathname)
    || request.method !== 'POST') {
    sendJson(response, { error: [404, 'not found'] }, 404)
    return
  }
  const body = await readJson(request)
  const method = String(body.method ?? '')
  const params = Array.isArray(body.params) ? body.params : []
  if (url.pathname === '/sony/avContent') {
    if (method === 'getAvailableApiList') {
      sendJson(response, {
        result: [['getSchemeList', 'getSourceList', 'getContentCount', 'getContentList']],
        id: 1,
      })
      return
    }
    if (method === 'getSchemeList') {
      sendJson(response, { result: [[{ scheme: 'storage' }]], id: 1 })
      return
    }
    if (method === 'getSourceList') {
      sendJson(response, { result: [[{ source: `${base}/source/1` }]], id: 1 })
      return
    }
    if (method === 'getContentList') {
      const options = params[0] && typeof params[0] === 'object'
        ? params[0] as Record<string, unknown>
        : {}
      if (options.view === 'date' && String(options.uri).includes('/source/')) {
        sendJson(response, {
          result: [[{ uri: `${base}/date/20261021`, title: '20261021', contentCount: 2 }]],
          id: 1,
        })
        return
      }
      sendJson(response, {
        result: [[
          {
            contentKind: 'still',
            content: { original: [{ fileName: 'DSC0002.JPG', url: `${base}/DSC0002.JPG` }] },
          },
          {
            contentKind: 'still',
            content: { original: [{ fileName: 'DSC0001.JPG', url: `${base}/DSC0001.JPG` }] },
          },
        ]],
        id: 1,
      })
      return
    }
    sendJson(response, { error: [1, 'unsupported content method'] }, 200)
    return
  }
  const methods = [
    'getApplicationInfo', 'getAvailableApiList', 'startRecMode',
    'getAvailableIsoSpeedRate', 'getAvailableShutterSpeed',
    'getAvailableFNumber', 'getAvailableExposureCompensation',
    'getAvailableWhiteBalance', 'getAvailableFocusMode',
    'setIsoSpeedRate', 'setShutterSpeed', 'setFNumber',
    'setExposureCompensation', 'setFocusMode', 'setLiveviewFrameInfo',
    'startLiveview', 'actTakePicture',
  ]
  if (method === 'getAvailableApiList') {
    sendJson(response, { result: [methods], id: 1 })
    return
  }
  if (method === 'getApplicationInfo') {
    sendJson(response, { result: [['Sony Alpha 7C', '2.0.0']], id: 1 })
    return
  }
  if (method === 'startRecMode') {
    startRecCalls++
    sendJson(response, { result: [0], id: 1 })
    return
  }
  if (method === 'setCameraFunction') {
    cameraFunction = String(params[0] ?? '')
    sendJson(response, { result: [0], id: 1 })
    return
  }
  if (method === 'getAvailableIsoSpeedRate') {
    sendJson(response, { result: [iso, ['AUTO', '100', '400', '800']], id: 1 })
    return
  }
  if (method === 'getAvailableShutterSpeed') {
    sendJson(response, { result: ['1/125', ['1/60', '1/125', '1/250']], id: 1 })
    return
  }
  if (method === 'getAvailableFNumber') {
    sendJson(response, { result: ['f4.0', ['f2.8', 'f4.0']], id: 1 })
    return
  }
  if (method === 'getAvailableExposureCompensation') {
    sendJson(response, { result: [0, 9, -9, 1], id: 1 })
    return
  }
  if (method === 'getAvailableWhiteBalance') {
    sendJson(response, {
      result: [
        { whiteBalanceMode: 'Auto WB', colorTemperature: -1 },
        [{ whiteBalanceMode: 'Auto WB' }, { whiteBalanceMode: 'Daylight' }],
      ],
      id: 1,
    })
    return
  }
  if (method === 'getAvailableFocusMode') {
    sendJson(response, { result: ['AF-S', ['AF-S', 'MF']], id: 1 })
    return
  }
  if (method === 'setIsoSpeedRate') {
    iso = String(params[0] ?? '')
    sendJson(response, { result: [0], id: 1 })
    return
  }
  if (method === 'setShutterSpeed' || method === 'setFNumber'
    || method === 'setExposureCompensation' || method === 'setFocusMode') {
    sendJson(response, { result: [0], id: 1 })
    return
  }
  if (method === 'setLiveviewFrameInfo') {
    sendJson(response, { result: [0], id: 1 })
    return
  }
  if (method === 'startLiveview') {
    sendJson(response, { result: [[`${base}/liveview`]], id: 1 })
    return
  }
  if (method === 'actTakePicture') {
    sendJson(response, { result: [[`${base}/photo.jpg`]], id: 1 })
    return
  }
  sendJson(response, { error: [1, 'unsupported'] }, 200)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinkrose-sony-'))
  iso = '400'
  startRecCalls = 0
  cameraFunction = 'Remote Shooting'
  server = createServer((request, response) => {
    void fakeSony(request, response).catch(error => {
      sendJson(response, { error: [500, String(error)] }, 500)
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no port')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close(error => error ? reject(error) : resolve())
    })
    server = null
  }
  await rm(root, { recursive: true, force: true })
})

describe('Sony Camera Remote 适配器', () => {
  it('规范地址：默认 10000 端口并拒绝凭据', () => {
    expect(sonyCameraBaseUrl('192.168.1.70')).toBe('http://192.168.1.70:10000')
    expect(() => sonyCameraBaseUrl('http://user:pass@camera.local')).toThrow(/用户名或密码/)
  })

  it('进入远程模式，读取机型、能力与相机返回的参数', async () => {
    const provider = createSonyCameraProvider({ root, url: base })
    const status = await provider.status()
    expect(status).toMatchObject({
      connected: true,
      model: 'Sony Alpha 7C',
      capabilities: { liveView: true, shutter: true, settings: true },
    })
    expect(startRecCalls).toBe(1)
    expect(status.settingsSchema).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'iso', type: 'select' }),
      expect.objectContaining({ key: 'exposureCompensation', type: 'number', min: -9, max: 9 }),
      expect.objectContaining({ key: 'whiteBalance', readOnly: true }),
    ]))
    expect(await provider.getSettings!()).toMatchObject({
      iso: '400', shutter: '1/125', aperture: 'f4.0', focusMode: 'AF-S',
    })
  })

  it('写回 Sony 参数并从相机重新读取', async () => {
    const provider = createSonyCameraProvider({ root, url: base })
    await provider.status()
    expect(await provider.setSettings!({ iso: '800' })).toMatchObject({ iso: '800' })
    expect((await provider.getSettings!()).iso).toBe('800')
  })

  it('解析 Sony 二进制实时取景流中的 JPEG', async () => {
    const provider = createSonyCameraProvider({ root, url: base })
    await provider.status()
    expect(await provider.liveView!()).toEqual(new Uint8Array(JPEG))
  })

  it('按快门后下载相机返回的 JPEG', async () => {
    const provider = createSonyCameraProvider({ root, url: base })
    await provider.status()
    expect(await provider.capture!()).toEqual({ saved: 'photo.jpg' })
    expect(await readFile(join(root, 'photo.jpg'))).toEqual(JPEG)
  })

  it('切到 Contents Transfer，按日期导入最近照片并切回遥控拍摄', async () => {
    const provider = createSonyCameraProvider({ root, url: base })
    const status = await provider.status()
    expect(status.capabilities.import).toBe(true)
    expect(await provider.importRecent!(2)).toEqual({
      imported: ['DSC0002.JPG', 'DSC0001.JPG'],
    })
    expect(await readFile(join(root, 'DSC0001.JPG'))).toEqual(JPEG)
    expect(await readFile(join(root, 'DSC0002.JPG'))).toEqual(JPEG)
    expect(cameraFunction).toBe('Remote Shooting')
    expect(await provider.importRecent!(2)).toEqual({ imported: [] })
  })

  it('连不上时给出 Sony 遥控拍摄的检查路径', async () => {
    const provider = createSonyCameraProvider({
      root,
      url: '192.168.1.70',
      fetchImpl: vi.fn(async () => {
        throw new Error('socket detail')
      }),
    })
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(status.diagnostic).toContain('遥控拍摄')
    expect(status.diagnostic).toContain('Wi-Fi')
    expect(status.diagnostic).not.toContain('socket detail')
  })
})
