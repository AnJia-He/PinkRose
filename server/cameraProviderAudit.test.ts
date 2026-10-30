import { describe, expect, it, vi } from 'vitest'
import { auditCameraProvider } from './cameraProviderAudit.ts'
import type { CameraControlProvider } from './cameraBridge.ts'

function connected(extra: Partial<CameraControlProvider> = {}): CameraControlProvider {
  return {
    status: async () => ({
      connected: true,
      model: 'Audit Camera',
      capabilities: { liveView: true, shutter: true, settings: true },
      settingsSchema: [
        { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 6400, step: 100 },
      ],
    }),
    liveView: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    getSettings: async () => ({ iso: 400 }),
    setSettings: vi.fn(async patch => patch),
    ...extra,
  }
}

describe('camera provider audit', () => {
  it('只读体检覆盖状态、实时取景和参数读取，不碰快门', async () => {
    const control = connected()
    const report = await auditCameraProvider(control)
    expect(report.ok).toBe(true)
    expect(report.checks.map(check => check.id)).toEqual([
      'status', 'liveView', 'settingsRead',
    ])
    expect(report.checks.find(check => check.id === 'liveView')?.detail).toContain('JPEG')
    expect(control.setSettings).not.toHaveBeenCalled()
  })

  it('显式开启后才把当前参数原值写回一次', async () => {
    const control = connected()
    const report = await auditCameraProvider(control, { writeSettings: true })
    expect(report.ok).toBe(true)
    expect(report.checks.some(check => check.id === 'settingsWrite' && check.ok)).toBe(true)
    expect(control.setSettings).toHaveBeenCalledWith({ iso: 400 })
  })

  it('能力声明与实现不一致、空取景、未连接都会明确失败', async () => {
    const missingLive = connected({
      liveView: undefined,
    })
    const noLive = await auditCameraProvider(missingLive)
    expect(noLive.ok).toBe(false)
    expect(noLive.checks.find(check => check.id === 'liveView')?.detail).toContain('没有 liveView')

    const emptyFrame = connected({ liveView: async () => null })
    const noFrame = await auditCameraProvider(emptyFrame)
    expect(noFrame.ok).toBe(false)
    expect(noFrame.checks.find(check => check.id === 'liveView')?.detail).toContain('这一帧为空')

    const offline: CameraControlProvider = {
      status: async () => ({
        connected: false,
        model: null,
        capabilities: { liveView: false, shutter: false, settings: false },
        diagnostic: '请连接相机',
      }),
    }
    const disconnected = await auditCameraProvider(offline)
    expect(disconnected.ok).toBe(false)
    expect(disconnected.checks[0]).toMatchObject({ id: 'status', ok: false })
  })
})
