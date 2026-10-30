import { describe, expect, it } from 'vitest'
import {
  cameraConnectionKey, cameraConnectionsJson, loadCameraConnections, makeCameraConnection,
  MAX_CAMERA_CONNECTIONS, saveCameraConnections, upsertCameraConnection,
  parseCameraConnectionsJson,
} from './cameraConnections'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('相机连接配置', () => {
  it('默认名称含方式与地址，端口会校验；同一目标只保留一条', () => {
    const canon = makeCameraConnection({
      kind: 'canon-ccapi', address: '192.168.1.60', port: '8080',
    })
    expect(canon.label).toBe('Canon CCAPI · 192.168.1.60:8080')
    expect(canon.id).toBe(cameraConnectionKey(canon))
    expect(() => makeCameraConnection({
      kind: 'gphoto2', address: '192.168.1.50', port: '70000',
    })).toThrow(/1~65535/)

    const updated = { ...canon, label: '影棚 Canon' }
    expect(upsertCameraConnection([canon], updated)).toEqual([updated])
  })

  it('最多保存 8 台，坏记录与重复目标会被过滤', () => {
    const storage = memoryStorage()
    const profiles = Array.from({ length: 10 }, (_, i) => makeCameraConnection({
      kind: 'sony-camera', address: `192.168.1.${i + 10}`,
    }))
    saveCameraConnections(profiles, storage)
    expect(loadCameraConnections(storage)).toHaveLength(MAX_CAMERA_CONNECTIONS)

    storage.setItem('pinkrose.camera.connections.v1', JSON.stringify([
      profiles[0],
      profiles[0],
      { kind: 'bad', address: 'camera', port: '', label: '坏记录' },
    ]))
    expect(loadCameraConnections(storage)).toEqual([profiles[0]])
  })

  it('自定义名称会被保留，空地址直接拒绝', () => {
    const profile = makeCameraConnection({
      kind: 'gphoto2', address: '192.168.1.50', port: '', label: '桌面 USB 常驻机位',
    })
    expect(profile.label).toBe('桌面 USB 常驻机位')
    expect(() => makeCameraConnection({
      kind: 'gphoto2', address: ' ', port: '',
    })).toThrow(/相机地址/)
  })

  it('跨设备导出只含白名单字段，导入会校验并去重', () => {
    const canon = makeCameraConnection({
      kind: 'canon-ccapi', address: '192.168.1.60', port: '8080', label: '影棚 Canon',
    })
    const text = cameraConnectionsJson([canon])
    expect(text).toContain('影棚 Canon')
    expect(text).not.toContain('token')
    expect(parseCameraConnectionsJson(text)).toEqual({
      connections: [canon],
      skipped: 0,
    })

    const mixed = JSON.stringify({
      version: 1,
      connections: [
        canon,
        { ...canon, label: '重复目标' },
        { kind: 'bad', address: 'x' },
      ],
    })
    expect(parseCameraConnectionsJson(mixed)).toEqual({
      connections: [canon],
      skipped: 2,
    })
  })

  it('拒绝坏 JSON、未知版本和空列表', () => {
    expect(() => parseCameraConnectionsJson('{')).toThrow(/JSON/)
    expect(() => parseCameraConnectionsJson('{"version":99,"connections":[]}'))
      .toThrow(/格式不支持/)
    expect(() => parseCameraConnectionsJson('{"version":1,"connections":[]}'))
      .toThrow(/没有可用/)
  })
})
