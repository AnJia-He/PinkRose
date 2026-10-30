import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cameraConverterArgs, createCameraBridgeServer, createMockCameraProvider, listCameraPhotos,
  type CameraConverter, type CameraControlProvider,
} from './cameraBridge.ts'
import { loadPersistedCameraControl } from './cameraRuntimeConfig.ts'

let root = ''
let cacheRoot = ''
let server: Server | null = null
let base = ''

function listen(target: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', () => {
      const address = target.address()
      if (!address || typeof address === 'string') return reject(new Error('没有拿到测试端口'))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(target: Server): Promise<void> {
  return new Promise(resolve => target.close(() => resolve()))
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pinkrose-bridge-'))
  cacheRoot = mkdtempSync(join(tmpdir(), 'pinkrose-bridge-cache-'))
  server = createCameraBridgeServer({
    root,
    allowedOrigins: ['http://localhost:5173'],
  })
  base = await listen(server)
})

afterEach(async () => {
  if (server) await close(server)
  server = null
  rmSync(root, { recursive: true, force: true })
  rmSync(cacheRoot, { recursive: true, force: true })
})

describe('相机文件夹桥', () => {
  it('只列照片、按修改时间倒序，并带 CORS 与可下载 URL', async () => {
    writeFileSync(join(root, 'old.jpg'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'new.heic'), Buffer.from([4, 5, 6, 7]))
    mkdirSync(join(root, 'day'))
    writeFileSync(join(root, 'day', 'nested.png'), Buffer.from([8, 9]))
    writeFileSync(join(root, 'notes.txt'), 'ignore me')
    writeFileSync(join(root, '.hidden.jpg'), 'ignore me')

    const old = new Date('2026-10-18T08:00:00Z')
    const middle = new Date('2026-10-18T09:00:00Z')
    const newest = new Date('2026-10-18T10:00:00Z')
    utimesSync(join(root, 'old.jpg'), old, old)
    utimesSync(join(root, 'day', 'nested.png'), middle, middle)
    utimesSync(join(root, 'new.heic'), newest, newest)

    expect((await listCameraPhotos(root)).map(photo => photo.name))
      .toEqual(['new.heic', 'nested.png', 'old.jpg'])

    const health = await fetch(`${base}/api/camera/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(health.status).toBe(200)
    expect(health.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(await health.json()).toMatchObject({ ok: true, count: 3 })

    const list = await fetch(`${base}/api/camera/photos`, {
      headers: { origin: 'http://localhost:5173' },
    })
    const body = await list.json() as {
      photos: { name: string; type: string; url: string }[]
    }
    expect(body.photos.map(photo => photo.name))
      .toEqual(['new.heic', 'nested.png', 'old.jpg'])
    expect(body.photos[0]!.type).toBe('image/heic')
    expect((body.photos[0] as { convertible?: boolean }).convertible).toBe(false)

    const file = await fetch(`${base}${body.photos[0]!.url}`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('image/heic')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([4, 5, 6, 7]))
  })

  it('★ RAW+JPEG 同名只列一条，JPEG 为主条目并挂上 RAW 元数据', async () => {
    writeFileSync(join(root, 'IMG_0001.JPG'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'IMG_0001.CR3'), Buffer.from([4, 5, 6, 7]))
    writeFileSync(join(root, 'IMG_0001.xmp'), Buffer.from('<xmp />'))
    const list = await listCameraPhotos(root)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'IMG_0001.JPG',
      raw: { name: 'IMG_0001.CR3', size: 4 },
      sidecar: { name: 'IMG_0001.xmp', type: 'application/rdf+xml' },
    })

    const body = await (await fetch(`${base}/api/camera/photos`)).json() as {
      photos: {
        name: string
        raw: { name: string; url: string; convertUrl: string | null } | null
        sidecar: { name: string; url: string; type: string } | null
      }[]
    }
    expect(body.photos).toHaveLength(1)
    expect(body.photos[0]!.raw).toMatchObject({
      name: 'IMG_0001.CR3',
      url: '/api/camera/file?id=IMG_0001.CR3',
      convertUrl: null,
    })
    expect(body.photos[0]!.sidecar).toMatchObject({
      name: 'IMG_0001.xmp',
      url: '/api/camera/file?id=IMG_0001.xmp',
      type: 'application/rdf+xml',
    })
    const sidecar = await fetch(`${base}${body.photos[0]!.sidecar!.url}`)
    expect(sidecar.headers.get('content-type')).toBe('application/rdf+xml')
  })

  it('相机软件按年 / 月 / 日建三层目录时仍能列出，并保留同名文件的目录', async () => {
    const dayOne = join(root, '2026', '10', '20')
    const dayTwo = join(root, '2026', '10', '21')
    mkdirSync(dayOne, { recursive: true })
    mkdirSync(dayTwo, { recursive: true })
    writeFileSync(join(dayOne, 'IMG_0001.JPG'), Buffer.from([1]))
    writeFileSync(join(dayTwo, 'IMG_0001.JPG'), Buffer.from([2]))

    const photos = await listCameraPhotos(root)
    expect(photos).toHaveLength(2)
    expect(photos.map(photo => ({
      id: photo.id,
      name: photo.name,
      folder: photo.folder,
    }))).toEqual(expect.arrayContaining([
      {
        id: '2026/10/20/IMG_0001.JPG',
        name: 'IMG_0001.JPG',
        folder: '2026/10/20',
      },
      {
        id: '2026/10/21/IMG_0001.JPG',
        name: 'IMG_0001.JPG',
        folder: '2026/10/21',
      },
    ]))
  })

  it('路径不能逃出相机目录，也不接受写请求', async () => {
    writeFileSync(join(root, 'inside.jpg'), 'inside')
    const outside = join(root, '..', `secret-${Date.now()}.txt`)
    writeFileSync(outside, 'secret')
    try {
      const escape = await fetch(
        `${base}/api/camera/file?id=${encodeURIComponent(`../${outside.split(/[\\/]/).pop()}`)}`,
      )
      expect(escape.status).toBe(403)
      const write = await fetch(`${base}/api/camera/photos`, { method: 'POST' })
      expect(write.status).toBe(405)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('有转换器时给 RAW / HEIC 提供 JPG 端点，并把结果缓存住', async () => {
    const converter: CameraConverter = {
      kind: 'magick',
      command: process.execPath,
      args: (_input, output) => [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(output)}, Buffer.from([255,216,255,217]))`,
      ],
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      cacheDir: cacheRoot,
      converter,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)
    writeFileSync(join(root, 'shot.cr3'), Buffer.from([1, 2, 3]))

    const list = await fetch(`${base}/api/camera/photos`)
    const body = await list.json() as {
      photos: { name: string; convertible: boolean; convertUrl: string | null }[]
    }
    expect(body.photos[0]).toMatchObject({
      name: 'shot.cr3',
      convertible: true,
      convertUrl: '/api/camera/convert?id=shot.cr3',
    })

    const first = await fetch(`${base}${body.photos[0]!.convertUrl!}`)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await first.arrayBuffer())).toEqual(Buffer.from([255, 216, 255, 217]))

    const second = await fetch(`${base}${body.photos[0]!.convertUrl!}`)
    expect(Buffer.from(await second.arrayBuffer())).toEqual(Buffer.from([255, 216, 255, 217]))
  })

  it('多个转换器按照片格式分工：RAW 不用 HEIC 工具，HEIC 也不用 RAW 工具', async () => {
    const converter = (
      kind: CameraConverter['kind'],
      formats: CameraConverter['formats'],
      last: number,
    ): CameraConverter => ({
      kind,
      command: process.execPath,
      formats,
      args: (_input, output) => [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(output)}, Buffer.from([255,216,255,217,${last}]))`,
      ],
    })
    const raw = converter('rawtherapee', ['raw'], 1)
    const heic = converter('sips', ['heic', 'tiff'], 2)
    await close(server!)
    server = createCameraBridgeServer({
      root,
      cacheDir: cacheRoot,
      converters: [raw, heic],
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)
    writeFileSync(join(root, 'shot.cr3'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'phone.heic'), Buffer.from([4, 5, 6]))

    const body = await (await fetch(`${base}/api/camera/photos`)).json() as {
      photos: { name: string; convertUrl: string | null }[]
    }
    const urls = Object.fromEntries(body.photos.map(photo => [photo.name, photo.convertUrl]))
    expect(urls['shot.cr3']).toBeTruthy()
    expect(urls['phone.heic']).toBeTruthy()

    const rawBytes = Buffer.from(await (await fetch(`${base}${urls['shot.cr3']}`)).arrayBuffer())
    const heicBytes = Buffer.from(await (await fetch(`${base}${urls['phone.heic']}`)).arrayBuffer())
    expect([...rawBytes]).toEqual([255, 216, 255, 217, 1])
    expect([...heicBytes]).toEqual([255, 216, 255, 217, 2])
  })

  it('★ 跨设备令牌：没有 / 错误令牌都拒绝，请求头与查询参数都可放行', async () => {
    await close(server!)
    server = createCameraBridgeServer({
      root,
      token: 'test-token-123',
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)
    writeFileSync(join(root, 'shot.jpg'), Buffer.from([1, 2, 3]))

    const lanOrigin = 'http://192.168.1.20:5173'
    const denied = await fetch(`${base}/api/camera/health`, {
      headers: { origin: lanOrigin },
    })
    expect(denied.status).toBe(401)
    // 跨设备时来源是局域网地址，令牌才是认证边界；预检和实际请求都要能过 CORS。
    expect(denied.headers.get('access-control-allow-origin')).toBe(lanOrigin)

    const wrong = await fetch(`${base}/api/camera/photos?token=wrong-token`, {
      headers: { origin: lanOrigin },
    })
    expect(wrong.status).toBe(401)

    const viaHeader = await fetch(`${base}/api/camera/health`, {
      headers: {
        origin: lanOrigin,
        'x-pinkrose-bridge-token': 'test-token-123',
      },
    })
    expect(viaHeader.status).toBe(200)
    expect(await viaHeader.json()).toMatchObject({ ok: true, count: 1 })

    const viaQuery = await fetch(`${base}/api/camera/file?id=shot.jpg&token=test-token-123`)
    expect(viaQuery.status).toBe(200)
    expect(Buffer.from(await viaQuery.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]))

    const noTokenFile = await fetch(`${base}/api/camera/file?id=shot.jpg`)
    expect(noTokenFile.status).toBe(401)
  })

  it('转换器参数按 sips / magick 分开生成', () => {
    expect(cameraConverterArgs('sips', 'in.heic', 'out.jpg'))
      .toEqual(['-s', 'format', 'jpeg', 'in.heic', '--out', 'out.jpg'])
    expect(cameraConverterArgs('magick', 'in.cr3', 'out.jpg'))
      .toEqual(['in.cr3', '-auto-orient', '-quality', '92', 'out.jpg'])
  })

  it('相机控制适配器提供状态、实时取景和快门，文件夹桥也能接住', async () => {
    const source = join(root, 'mock-live.jpg')
    writeFileSync(source, Buffer.from([9, 8, 7]))
    const control = createMockCameraProvider(source, root)
    await close(server!)
    server = createCameraBridgeServer({
      root,
      control,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)

    const status = await fetch(`${base}/api/camera/control`)
    expect(await status.json()).toMatchObject({
      connected: true,
      model: 'Mock Camera',
      capabilities: { liveView: true, shutter: true, settings: true },
    })

    const live = await fetch(`${base}/api/camera/liveview`)
    expect(live.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await live.arrayBuffer())).toEqual(Buffer.from([9, 8, 7]))

    const shutter = await fetch(`${base}/api/camera/shutter`, {
      method: 'POST',
      headers: { 'x-pinkrose-camera': '1' },
    })
    expect(shutter.status).toBe(200)
    const result = await shutter.json() as { result: { saved: string } }
    expect(result.result.saved).toMatch(/^capture-\d+\.jpg$/)

    const photos = await (await fetch(`${base}/api/camera/photos`)).json() as {
      photos: { name: string }[]
    }
    expect(photos.photos.some(photo => photo.name === result.result.saved)).toBe(true)

    const settings = await fetch(`${base}/api/camera/settings`)
    expect(await settings.json()).toMatchObject({ settings: { iso: 400 } })
    const patched = await fetch(`${base}/api/camera/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ iso: 800, shutter: '1/250' }),
    })
    expect(await patched.json()).toMatchObject({
      settings: { iso: 800, shutter: '1/250' },
    })
  })

  it('快门失败时说清是拍摄失败，不误报成目录读取失败', async () => {
    const control: CameraControlProvider = {
      status: async () => ({
        connected: true,
        model: 'Mock Camera',
        capabilities: { liveView: false, shutter: true, settings: false },
      }),
      capture: async () => {
        throw new Error('gphoto2 raw failure /private/camera/session')
      },
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      control,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)

    const shutter = await fetch(`${base}/api/camera/shutter`, {
      method: 'POST',
      headers: { 'x-pinkrose-camera': '1' },
    })
    expect(shutter.status).toBe(422)
    const body = await shutter.json() as { error?: string }
    expect(body.error).toContain('快门没按成')
    expect(body.error).not.toContain('读目录')
    expect(body.error).not.toContain('/private/camera/session')
  })

  it('参数写入失败时提示检查相机支持，不暴露适配器原始错误', async () => {
    const control: CameraControlProvider = {
      status: async () => ({
        connected: true,
        model: 'Mock Camera',
        capabilities: { liveView: false, shutter: false, settings: true },
      }),
      getSettings: async () => ({ iso: 400 }),
      setSettings: async () => {
        throw new Error('PTP config write failed /private/camera/session')
      },
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      control,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)

    const settings = await fetch(`${base}/api/camera/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ iso: 800 }),
    })
    expect(settings.status).toBe(422)
    const body = await settings.json() as { error?: string }
    expect(body.error).toContain('参数没应用上')
    expect(body.error).not.toContain('读目录')
    expect(body.error).not.toContain('/private/camera/session')
  })

  it('实时取景和参数读取失败时给出各自的可恢复提示', async () => {
    const control: CameraControlProvider = {
      status: async () => ({
        connected: true,
        model: 'Mock Camera',
        capabilities: { liveView: true, shutter: false, settings: true },
      }),
      liveView: async () => {
        throw new Error('SDK preview crashed /private/camera/session')
      },
      getSettings: async () => {
        throw new Error('SDK settings crashed /private/camera/session')
      },
      setSettings: async patch => patch,
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      control,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)

    const live = await fetch(`${base}/api/camera/liveview`)
    expect(live.status).toBe(502)
    const liveBody = await live.json() as { error?: string }
    expect(liveBody.error).toContain('实时取景暂时没画面')
    expect(liveBody.error).not.toContain('/private/camera/session')

    const settings = await fetch(`${base}/api/camera/settings`)
    expect(settings.status).toBe(422)
    const settingsBody = await settings.json() as { error?: string }
    expect(settingsBody.error).toContain('相机参数暂时读不到')
    expect(settingsBody.error).not.toContain('/private/camera/session')
  })

  it('相机状态读取失败时返回可恢复提示，不让面板整体报错', async () => {
    const control: CameraControlProvider = {
      status: async () => {
        throw new Error('SDK status crashed /private/camera/session')
      },
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      control,
      allowedOrigins: ['http://localhost:5173'],
    })
    base = await listen(server)

    const status = await fetch(`${base}/api/camera/control`)
    expect(status.status).toBe(200)
    const body = await status.json() as {
      connected?: boolean
      diagnostic?: string
    }
    expect(body.connected).toBe(false)
    expect(body.diagnostic).toContain('相机状态暂时读不到')
    expect(body.diagnostic).not.toContain('/private/camera/session')
  })

  it('★ 网页可以运行时把桥接到指定 IP 的 gphoto2 相机', async () => {
    let configured: unknown = null
    const wireless: CameraControlProvider = {
      status: async () => ({
        connected: true,
        model: 'Wireless Mock',
        capabilities: { liveView: true, shutter: true, settings: false },
      }),
    }
    await close(server!)
    server = createCameraBridgeServer({
      root,
      allowedOrigins: ['http://localhost:5173'],
      configureControl: async config => {
        configured = config
        return wireless
      },
    })
    base = await listen(server)

    const noMarker = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'gphoto2', ip: '192.168.1.50' }),
    })
    expect(noMarker.status).toBe(403)

    const badIp = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ kind: 'gphoto2', ip: 'http://not-an-ip.example' }),
    })
    expect(badIp.status).toBe(400)
    expect(configured).toBeNull()

    const ok = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ kind: 'gphoto2', ip: '192.168.1.50', port: '15740' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      ok: true,
      control: { connected: true, model: 'Wireless Mock' },
    })
    expect(configured).toEqual({
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })

    const canon = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ kind: 'canon-ccapi', url: '192.168.1.60' }),
    })
    expect(canon.status).toBe(200)
    expect(configured).toEqual({
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })

    const sony = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ kind: 'sony-camera', url: '192.168.1.70' }),
    })
    expect(sony.status).toBe(200)
    expect(configured).toEqual({
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })

    const current = await (await fetch(`${base}/api/camera/control`)).json()
    expect(current).toMatchObject({
      connected: true,
      model: 'Wireless Mock',
      canConfigure: true,
    })

    const reset = await fetch(`${base}/api/camera/provider`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
      },
      body: JSON.stringify({ kind: 'none' }),
    })
    expect(reset.status).toBe(200)
    await expect(loadPersistedCameraControl(root)).resolves.toBeNull()
  })

  it('支持从相机导入最近照片，并强制校验控制标记和数量', async () => {
    const calls: number[] = []
    const control: CameraControlProvider = {
      status: async () => ({
        connected: true,
        model: 'Import Camera',
        capabilities: { liveView: false, shutter: true, settings: false, import: true },
      }),
      importRecent: async limit => {
        calls.push(limit)
        return { imported: ['IMG_0001.JPG'] }
      },
    }
    await close(server!)
    server = createCameraBridgeServer({ root, control })
    base = await listen(server)

    const noMarker = await fetch(`${base}/api/camera/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })
    expect(noMarker.status).toBe(403)

    const tooMany = await fetch(`${base}/api/camera/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pinkrose-camera': '1' },
      body: JSON.stringify({ limit: 101 }),
    })
    expect(tooMany.status).toBe(400)

    const ok = await fetch(`${base}/api/camera/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pinkrose-camera': '1' },
      body: JSON.stringify({ limit: 5 }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({
      ok: true,
      result: { imported: ['IMG_0001.JPG'] },
    })
    expect(calls).toEqual([5])
  })

  it('文件夹桥没有控制适配器时，实时取景和快门明确说没有', async () => {
    expect((await fetch(`${base}/api/camera/liveview`)).status).toBe(501)
    expect((await fetch(`${base}/api/camera/shutter`, { method: 'POST' })).status).toBe(501)
    expect((await fetch(`${base}/api/camera/settings`)).status).toBe(501)
  })
})
