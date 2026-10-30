import type { CameraControlProvider, CameraControlStatus } from './cameraBridge.ts'

export type CameraAuditCheck = {
  id: 'status' | 'liveView' | 'settingsRead' | 'settingsWrite'
  label: string
  ok: boolean
  detail: string
}

export type CameraAuditReport = {
  ok: boolean
  status: CameraControlStatus
  checks: CameraAuditCheck[]
}

export type CameraAuditOptions = {
  /** 连上后读一帧实时取景；默认开。 */
  liveView?: boolean
  /** 连上后读一次参数；默认开。 */
  settings?: boolean
  /** 显式要求时才把当前参数原值写回一次。默认关，避免擅自改相机。 */
  writeSettings?: boolean
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 240)
}

/**
 * 厂商相机适配器的无拍摄体检。只读状态 / 取景 / 参数；写回必须显式开启，
 * 且只写当前读到的那一组值。任何情况下都不按快门、不删照片。
 */
export async function auditCameraProvider(
  control: CameraControlProvider,
  options: CameraAuditOptions = {},
): Promise<CameraAuditReport> {
  const checks: CameraAuditCheck[] = []
  let status: CameraControlStatus
  try {
    status = await control.status()
    checks.push({
      id: 'status',
      label: '连接状态',
      ok: status.connected,
      detail: status.connected
        ? `${status.model ?? '未命名相机'} 已连接`
        : (status.diagnostic ?? '相机未连接'),
    })
  } catch (error) {
    throw new Error(`探针读不到相机状态：${errorText(error)}`)
  }

  if (status.connected && options.liveView !== false && status.capabilities.liveView) {
    if (!control.liveView) {
      checks.push({
        id: 'liveView',
        label: '实时取景',
        ok: false,
        detail: 'status 声明支持实时取景，但适配器没有 liveView()',
      })
    } else {
      try {
        const frame = await control.liveView()
        checks.push({
          id: 'liveView',
          label: '实时取景',
          ok: !!frame,
          detail: frame
            ? `收到 ${frame.length} 字节 ${frame[0] === 0xff ? 'JPEG' : 'PNG'} 帧`
            : '这一帧为空；检查相机是否在回放模式',
        })
      } catch (error) {
        checks.push({
          id: 'liveView',
          label: '实时取景',
          ok: false,
          detail: `读取失败：${errorText(error)}`,
        })
      }
    }
  }

  if (status.connected && options.settings !== false && status.capabilities.settings) {
    if (!control.getSettings) {
      checks.push({
        id: 'settingsRead',
        label: '参数读取',
        ok: false,
        detail: 'status 声明支持参数控制，但适配器没有 getSettings()',
      })
    } else {
      try {
        const settings = await control.getSettings()
        const count = Object.keys(settings).length
        checks.push({
          id: 'settingsRead',
          label: '参数读取',
          ok: count > 0,
          detail: count > 0 ? `读到 ${count} 项参数` : '参数对象是空的',
        })
        if (options.writeSettings) {
          if (!control.setSettings) {
            checks.push({
              id: 'settingsWrite',
              label: '参数写回',
              ok: false,
              detail: '适配器没有 setSettings()',
            })
          } else {
            try {
              const applied = await control.setSettings(settings)
              checks.push({
                id: 'settingsWrite',
                label: '参数写回',
                ok: Object.keys(applied).length > 0,
                detail: Object.keys(applied).length > 0
                  ? `已把 ${Object.keys(settings).length} 项原值写回并读回`
                  : '写回后没有读回参数',
              })
            } catch (error) {
              checks.push({
                id: 'settingsWrite',
                label: '参数写回',
                ok: false,
                detail: `写回失败：${errorText(error)}`,
              })
            }
          }
        }
      } catch (error) {
        checks.push({
          id: 'settingsRead',
          label: '参数读取',
          ok: false,
          detail: `读取失败：${errorText(error)}`,
        })
      }
    }
  }

  return { ok: checks.every(check => check.ok), status, checks }
}
