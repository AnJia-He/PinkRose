import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { guardCameraProvider, loadCameraProvider } from './cameraProvider.ts'
import type { CameraControlProvider, CameraControlStatus } from './cameraBridge.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-camera-provider-'))
  dirs.push(dir)
  const file = join(dir, name)
  await writeFile(file, source, 'utf8')
  return file
}

/**
 * Vitest 会拦截源码里的动态 import，把仓库外的临时 .mjs 当成待转换模块。
 * 用原生 `import()` 加载夹具，测的是这条加载逻辑本身（生产环境就是原生 import）。
 */
const requireFixture = createRequire(import.meta.url)
const importFixture = (url: string) =>
  Promise.resolve(requireFixture(fileURLToPath(url)) as unknown)

const status = (model: string): CameraControlStatus => ({
  connected: true,
  model,
  capabilities: { liveView: true, shutter: true, settings: false },
  settingsSchema: [],
})

describe('相机 provider 加载', () => {
  it('没有接可控相机 → null', async () => {
    expect(await loadCameraProvider({ kind: 'none' }, { root: '/tmp/photos' })).toBeNull()
  })

  it('mock / gphoto2 交给对应构造器', async () => {
    const fake = { status: async () => status('fake') } as CameraControlProvider
    const createMock = vi.fn(() => fake)
    const mockProvider = await loadCameraProvider(
      { kind: 'mock', source: '/tmp/source.jpg' }, { root: '/tmp/photos', createMock },
    )
    expect((await mockProvider!.status()).model).toBe('fake')
    expect(createMock).toHaveBeenCalledWith('/tmp/source.jpg', '/tmp/photos')

    const createGphoto = vi.fn(() => fake)
    const gphotoProvider = await loadCameraProvider(
      { kind: 'gphoto2', command: 'gphoto2' }, { root: '/tmp/photos', createGphoto },
    )
    expect((await gphotoProvider!.status()).model).toBe('fake')
    expect(createGphoto).toHaveBeenCalledWith({ root: '/tmp/photos', command: 'gphoto2' })
    const wireless = await loadCameraProvider(
      { kind: 'gphoto2', command: 'gphoto2', port: 'ptpip:192.168.1.50' },
      { root: '/tmp/photos', createGphoto },
    )
    expect((await wireless!.status()).model).toBe('fake')
    expect(createGphoto).toHaveBeenLastCalledWith({
      root: '/tmp/photos', command: 'gphoto2', port: 'ptpip:192.168.1.50',
    })

    const createCanon = vi.fn(() => fake)
    const canon = await loadCameraProvider(
      { kind: 'canon-ccapi', url: '192.168.1.60' },
      { root: '/tmp/photos', createCanon },
    )
    expect((await canon!.status()).model).toBe('fake')
    expect(createCanon).toHaveBeenCalledWith({
      root: '/tmp/photos', url: '192.168.1.60',
    })

    const createSony = vi.fn(() => fake)
    const sony = await loadCameraProvider(
      { kind: 'sony-camera', url: '192.168.1.70' },
      { root: '/tmp/photos', createSony },
    )
    expect((await sony!.status()).model).toBe('fake')
    expect(createSony).toHaveBeenCalledWith({
      root: '/tmp/photos', url: '192.168.1.70',
    })
  })

  it('★ 加载厂商适配器模块：工厂拿到 root，返回的 provider 直接可用', async () => {
    const file = await fixture('adapter.cjs', `
      module.exports = {
        createCameraProvider({ root }) {
          return {
          status: async () => ({
            connected: true,
            model: 'Plugin:' + root,
            capabilities: { liveView: true, shutter: true, settings: true },
            settingsSchema: [],
          }),
          liveView: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          }
        }
      }
    `)
    const provider = await loadCameraProvider(
      { kind: 'module', path: file },
      { root: '/tmp/camera-root', importModule: importFixture },
    )
    expect(provider).toBeTruthy()
    expect((await provider!.status()).model).toBe('Plugin:/tmp/camera-root')
    expect(await provider!.liveView!()).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  })

  it('默认导出一个现成 provider 对象也接受', async () => {
    const file = await fixture('object.cjs', `
      module.exports = {
        status: async () => ({
          connected: true, model: 'Object Cam',
          capabilities: { liveView: false, shutter: false, settings: false },
          settingsSchema: [],
        }),
      }
    `)
    const provider = await loadCameraProvider(
      { kind: 'module', path: file },
      { root: '/tmp/photos', importModule: importFixture },
    )
    expect((await provider!.status()).model).toBe('Object Cam')
  })

  it('文件不存在 / 没有工厂 / 返回值不合法 / 工厂抛错，都给能照着做的中文错误', async () => {
    await expect(loadCameraProvider(
      { kind: 'module', path: join(tmpdir(), 'pinkrose-not-there-xyz.mjs') },
      { root: '/tmp/photos' },
    )).rejects.toThrow(/适配器文件不存在/)

    const empty = await fixture('empty.cjs', 'module.exports = { nope: 1 }')
    await expect(loadCameraProvider(
      { kind: 'module', path: empty },
      { root: '/tmp/photos', importModule: importFixture },
    )).rejects.toThrow(/必须导出 createCameraProvider/)

    const bad = await fixture(
      'bad.cjs', 'module.exports = { createCameraProvider() { return {} } }',
    )
    await expect(loadCameraProvider(
      { kind: 'module', path: bad },
      { root: '/tmp/photos', importModule: importFixture },
    )).rejects.toThrow(/status\(\)/)

    const broken = await fixture(
      'broken.cjs',
      `module.exports = { createCameraProvider() { throw new Error('SDK not ready') } }`,
    )
    await expect(loadCameraProvider(
      { kind: 'module', path: broken },
      { root: '/tmp/photos', importModule: importFixture },
    )).rejects.toThrow(/适配器启动失败.*SDK not ready/)
  })

  it('★ 适配器返回值经过统一契约：畸形状态 / 帧 / 文件名 / 参数都拦下', async () => {
    const badStatus = guardCameraProvider({
      status: async () => ({ connected: 'yes' } as never),
    })
    await expect(badStatus.status()).rejects.toThrow(/connected/)

    const badFrame = guardCameraProvider({
      status: async () => status('frame'),
      liveView: async () => new Uint8Array([1, 2, 3, 4]),
    })
    await expect(badFrame.liveView!()).rejects.toThrow(/JPEG 或 PNG/)

    const badCapture = guardCameraProvider({
      status: async () => status('capture'),
      capture: async () => ({ saved: '../escape.jpg' }),
    })
    await expect(badCapture.capture!()).rejects.toThrow(/文件名不合法/)

    const badSettings = guardCameraProvider({
      status: async () => status('settings'),
      getSettings: async () => ({ iso: Number.NaN }),
    })
    await expect(badSettings.getSettings!()).rejects.toThrow(/有限数字/)

    const badImport = guardCameraProvider({
      status: async () => status('import'),
      importRecent: async () => ({ imported: ['../escape.jpg'] }),
    })
    await expect(badImport.importRecent!(10)).rejects.toThrow(/文件名不合法/)
  })

  it('★ 卡死的厂商适配器会超时，不让整个相机桥挂住', async () => {
    const provider = guardCameraProvider({
      status: () => new Promise(() => {}),
    }, { statusMs: 10 })
    await expect(provider.status()).rejects.toThrow(/超时/)
  })
})
