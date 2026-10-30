import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonCcapiCameraProvider } from './canonCcapi.ts'
import { canonCcapiBaseUrl } from './canonCcapiUrl.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x50, 0x52, 0xff, 0xd9])

let root = ''
let server: ReturnType<typeof createServer> | null = null
let base = ''
let iso = '400'
let shot = false

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  const value: unknown = JSON.parse(text)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function fakeCamera(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', base || 'http://127.0.0.1')
  const path = url.pathname
  if (path === '/ccapi') {
    sendJson(response, { ver100: [], ver110: [], ver130: [] })
    return
  }
  if (path === '/ccapi/ver100/deviceinformation') {
    sendJson(response, { productname: 'Canon EOS R7', serialnumber: 'fixture' })
    return
  }
  if (path === '/ccapi/ver100/devicestatus/battery') {
    sendJson(response, { level: '82', quality: 'good' })
    return
  }
  if (path === '/ccapi/ver110/shooting/settings' && request.method === 'GET') {
    sendJson(response, {
      iso: { value: iso, ability: { min: '100', max: '6400', step: '100' } },
      tv: { value: '1/125', ability: ['1/60', '1/125', '1/250'] },
      av: { value: 'f4.0', ability: ['f2.8', 'f4.0', 'f5.6'] },
      exposure: { value: '0', ability: { min: '-3', max: '3', step: '0.3' } },
      wb: { value: 'auto', ability: ['auto', 'daylight'] },
      drive: { value: 'single', ability: ['single', 'high'] },
      afmethod: { value: 'face', ability: ['face', 'zone'] },
      metering: { value: 'evaluative', ability: ['evaluative', 'center'] },
    })
    return
  }
  if (path === '/ccapi/ver110/shooting/settings/iso' && request.method === 'PUT') {
    const value = (await body(request)).value
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      sendJson(response, { message: 'bad iso' }, 400)
      return
    }
    iso = value
    sendJson(response, { value: iso })
    return
  }
  if (path === '/ccapi/ver110/devicestatus/currentdirectory') {
    sendJson(response, { path: '/ccapi/ver130/contents/sd/100CANON' })
    return
  }
  if (path === '/ccapi/ver130/contents/sd/100CANON') {
    sendJson(response, {
      path: [
        '/ccapi/ver130/contents/sd/100CANON/IMG_0001.JPG',
        ...(shot ? ['/ccapi/ver130/contents/sd/100CANON/IMG_0002.JPG'] : []),
      ],
    })
    return
  }
  if (path.endsWith('/IMG_0001.JPG') || path.endsWith('/IMG_0002.JPG')) {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': JPEG.length,
    })
    response.end(JPEG)
    return
  }
  if (path === '/ccapi/ver100/shooting/liveview' && request.method === 'POST') {
    sendJson(response, { status: 'ok' })
    return
  }
  if (path === '/ccapi/ver100/shooting/liveview/flip') {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': JPEG.length,
    })
    response.end(JPEG)
    return
  }
  if (path === '/ccapi/ver100/shooting/control/shutterbutton' && request.method === 'POST') {
    shot = true
    sendJson(response, { status: 'ok' })
    return
  }
  sendJson(response, { message: 'not found' }, 404)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinkrose-canon-ccapi-'))
  iso = '400'
  shot = false
  server = createServer((request, response) => {
    void fakeCamera(request, response).catch(error => {
      sendJson(response, { message: String(error) }, 500)
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

describe('Canon CCAPI 相机适配器', () => {
  it('规范地址：补 8080、拒绝凭据和非 HTTP 协议', () => {
    expect(canonCcapiBaseUrl('192.168.1.50')).toBe('http://192.168.1.50:8080')
    expect(canonCcapiBaseUrl('http://camera.local:9090/')).toBe('http://camera.local:9090')
    expect(() => canonCcapiBaseUrl('ftp://camera.local')).toThrow(/只支持/)
    expect(() => canonCcapiBaseUrl('http://user:pass@camera.local')).toThrow(/不要放用户名或密码/)
  })

  it('读取机型 / 电量 / 相机实际支持的曝光参数', async () => {
    const provider = createCanonCcapiCameraProvider({
      root,
      url: base,
      capturePollMs: 10,
      captureWaitMs: 200,
    })
    const status = await provider.status()
    expect(status).toMatchObject({
      connected: true,
      model: 'Canon EOS R7',
      capabilities: { liveView: true, shutter: true, settings: true },
    })
    expect(status.settingsSchema).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'iso', type: 'number', min: 100, max: 6400, step: 100 }),
      expect.objectContaining({ key: 'wb', type: 'select' }),
      expect.objectContaining({ key: 'battery', readOnly: true }),
    ]))
    expect(await provider.getSettings!()).toMatchObject({
      iso: 400,
      wb: 'auto',
      battery: 82,
    })
  })

  it('写回 ISO 后从相机重新读取，不保留假值', async () => {
    const provider = createCanonCcapiCameraProvider({ root, url: base })
    expect((await provider.getSettings!()).iso).toBe(400)
    expect(await provider.setSettings!({ iso: 800 })).toMatchObject({ iso: 800 })
    expect((await provider.getSettings!()).iso).toBe(800)
  })

  it('实时取景先启动再取 JPEG', async () => {
    const provider = createCanonCcapiCameraProvider({ root, url: base })
    expect(await provider.liveView!()).toEqual(new Uint8Array(JPEG))
  })

  it('按下快门后发现新文件，下载到桥目录并返回安全文件名', async () => {
    const provider = createCanonCcapiCameraProvider({
      root,
      url: base,
      capturePollMs: 10,
      captureWaitMs: 300,
    })
    const result = await provider.capture!()
    expect(result).toEqual({ saved: 'IMG_0002.JPG' })
    expect(await readFile(join(root, 'IMG_0002.JPG'))).toEqual(JPEG)
  })

  it('不按快门也能导入相机当前目录的最近照片，重复导入不产生副本', async () => {
    const provider = createCanonCcapiCameraProvider({ root, url: base })
    expect(await provider.importRecent!(10)).toEqual({
      imported: ['IMG_0001.JPG'],
    })
    expect(await stat(join(root, 'IMG_0001.JPG')))
      .toMatchObject({ size: JPEG.length })
    expect(await provider.importRecent!(10)).toEqual({ imported: [] })
  })

  it('连不上时返回可照做诊断；快门和取景都不可用', async () => {
    const provider = createCanonCcapiCameraProvider({
      root,
      url: '192.168.1.50',
      fetchImpl: vi.fn(async () => {
        throw new Error('offline raw detail')
      }),
    })
    const status = await provider.status()
    expect(status).toMatchObject({
      connected: false,
      model: null,
      capabilities: { liveView: false, shutter: false, settings: false },
    })
    expect(status.diagnostic).toContain('Camera Control API')
    expect(status.diagnostic).toContain('同一网络')
    expect(status.diagnostic).not.toContain('offline raw detail')
  })
})
