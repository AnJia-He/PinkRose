import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CAMERA_RUNTIME_CONFIG_FILE,
  loadPersistedCameraControl,
  parseCameraControlConfig,
  savePersistedCameraControl,
} from './cameraRuntimeConfig.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pinkrose-camera-config-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('无线相机运行时配置', () => {
  it('接受相机 IP 和可选数字端口，拒绝 URL / 空格 / 越界端口', () => {
    expect(parseCameraControlConfig({
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })).toEqual({
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })
    expect(() => parseCameraControlConfig({
      kind: 'gphoto2', ip: 'http://camera.local',
    })).toThrow(/IP/)
    expect(() => parseCameraControlConfig({
      kind: 'gphoto2', ip: '192.168.1.50', port: '70000',
    })).toThrow(/端口/)

    expect(parseCameraControlConfig({
      kind: 'canon-ccapi', url: '192.168.1.60',
    })).toEqual({
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })
    expect(() => parseCameraControlConfig({
      kind: 'canon-ccapi', url: 'ftp://192.168.1.60',
    })).toThrow(/只支持/)

    expect(parseCameraControlConfig({
      kind: 'sony-camera', url: '192.168.1.70',
    })).toEqual({
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })
  })

  it('保存后能恢复；文件只含 IP / 端口，不含命令或密钥', async () => {
    await savePersistedCameraControl(root, {
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'gphoto2', ip: '192.168.1.50', port: '15740',
    })
    const raw = await import('node:fs/promises').then(fs =>
      fs.readFile(join(root, CAMERA_RUNTIME_CONFIG_FILE), 'utf8'))
    expect(raw).toContain('192.168.1.50')
    expect(raw).not.toMatch(/command|token|password/i)
  })

  it('Canon CCAPI 地址也能保存和恢复', async () => {
    await savePersistedCameraControl(root, {
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'canon-ccapi', url: 'http://192.168.1.60:8080',
    })
  })

  it('Sony Camera Remote 地址也能保存和恢复', async () => {
    await savePersistedCameraControl(root, {
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })
    await expect(loadPersistedCameraControl(root)).resolves.toEqual({
      kind: 'sony-camera', url: 'http://192.168.1.70:10000',
    })
  })

  it('断开配置会删掉文件；坏文件只是不恢复，不拖垮桥', async () => {
    await savePersistedCameraControl(root, {
      kind: 'gphoto2', ip: '192.168.1.50',
    })
    await savePersistedCameraControl(root, { kind: 'none' })
    await expect(loadPersistedCameraControl(root)).resolves.toBeNull()

    writeFileSync(join(root, CAMERA_RUNTIME_CONFIG_FILE), '{broken json')
    await expect(loadPersistedCameraControl(root)).resolves.toBeNull()
  })
})
