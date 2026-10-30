/**
 * 多台相机的无线连接配置（只存本机）。
 *
 * 只保存连接方式、地址、端口和显示名；访问令牌仍由相机桥连接那一栏单独保管，
 * 不复制进配置列表，避免同一个密钥出现多份、改一处忘一处。
 */
export type CameraConnectionKind = 'gphoto2' | 'canon-ccapi' | 'sony-camera'

export type CameraConnection = {
  id: string
  kind: CameraConnectionKind
  address: string
  port: string
  label: string
}

export const CAMERA_CONNECTIONS_KEY = 'pinkrose.camera.connections.v1'
export const CAMERA_CONNECTIONS_EXPORT_VERSION = 1
export const MAX_CAMERA_CONNECTIONS = 8

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function cameraConnectionKind(value: unknown): CameraConnectionKind | null {
  return value === 'gphoto2' || value === 'canon-ccapi' || value === 'sony-camera'
    ? value
    : null
}

export function cameraConnectionKey(input: Pick<
  CameraConnection, 'kind' | 'address' | 'port'
>): string {
  return `${input.kind}|${input.address.trim().toLowerCase()}|${input.port.trim()}`
}

function defaultLabel(kind: CameraConnectionKind, address: string, port: string): string {
  const name = kind === 'canon-ccapi'
    ? 'Canon CCAPI'
    : kind === 'sony-camera' ? 'Sony Camera Remote' : 'PTP/IP'
  return `${name} · ${address}${port ? `:${port}` : ''}`
}

export function makeCameraConnection(input: {
  kind: CameraConnectionKind
  address: string
  port?: string
  label?: string
}): CameraConnection {
  const address = clean(input.address, 512)
  const port = clean(input.port, 16)
  if (!address) throw new Error('先填写相机地址。')
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('相机端口需要 1~65535；不确定就留空。')
  }
  const base = { kind: input.kind, address, port }
  return {
    ...base,
    id: cameraConnectionKey(base),
    label: clean(input.label, 80) || defaultLabel(input.kind, address, port),
  }
}

export function normalizeCameraConnection(raw: unknown): CameraConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const kind = cameraConnectionKind(body.kind)
  if (!kind) return null
  try {
    const made = makeCameraConnection({
      kind,
      address: clean(body.address, 512),
      port: clean(body.port, 16),
      label: clean(body.label, 80),
    })
    return { ...made, id: clean(body.id, 600) || made.id }
  } catch {
    return null
  }
}

export function upsertCameraConnection(
  current: readonly CameraConnection[],
  next: CameraConnection,
): CameraConnection[] {
  const key = cameraConnectionKey(next)
  return [
    next,
    ...current.filter(item => cameraConnectionKey(item) !== key && item.id !== next.id),
  ].slice(0, MAX_CAMERA_CONNECTIONS)
}

export function loadCameraConnections(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null : localStorage,
): CameraConnection[] {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(CAMERA_CONNECTIONS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed
      .map(normalizeCameraConnection)
      .filter((item): item is CameraConnection => {
        if (!item) return false
        const key = cameraConnectionKey(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_CAMERA_CONNECTIONS)
  } catch {
    return []
  }
}

export function saveCameraConnections(
  connections: readonly CameraConnection[],
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null : localStorage,
): void {
  if (!storage) return
  try {
    storage.setItem(
      CAMERA_CONNECTIONS_KEY,
      JSON.stringify(connections.slice(0, MAX_CAMERA_CONNECTIONS)),
    )
  } catch {
    // 隐私模式或存储已满：保留本次页面里的配置，不影响连接。
  }
}

/** 跨设备备份：导出字段白名单，访问令牌和桥地址不会进文件。 */
export function cameraConnectionsJson(connections: readonly CameraConnection[]): string {
  return JSON.stringify({
    version: CAMERA_CONNECTIONS_EXPORT_VERSION,
    connections: connections.slice(0, MAX_CAMERA_CONNECTIONS).map(profile => ({
      kind: profile.kind,
      address: profile.address,
      port: profile.port,
      label: profile.label,
    })),
  }, null, 2)
}

export function parseCameraConnectionsJson(text: string): {
  connections: CameraConnection[]
  skipped: number
} {
  if (!text.trim() || text.length > 1024 * 1024) throw new Error('这个文件不是相机连接配置。')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是有效 JSON。')
  }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null
  const list = Array.isArray(raw) ? raw : body?.connections
  if (!Array.isArray(list)) throw new Error('文件里没有相机连接列表。')
  if (body && body.version !== undefined && body.version !== CAMERA_CONNECTIONS_EXPORT_VERSION) {
    throw new Error('这版相机配置格式不支持，请从新版 PinkRose 重新导出。')
  }
  const connections: CameraConnection[] = []
  let skipped = 0
  for (const item of list) {
    const profile = normalizeCameraConnection(item)
    if (!profile || connections.some(existing =>
      cameraConnectionKey(existing) === cameraConnectionKey(profile))) {
      skipped++
      continue
    }
    connections.push(profile)
    if (connections.length >= MAX_CAMERA_CONNECTIONS) break
  }
  if (connections.length === 0) throw new Error('文件里没有可用的相机连接。')
  return { connections, skipped }
}
