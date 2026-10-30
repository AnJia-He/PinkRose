/**
 * 无线相机运行时配置的持久化。
 *
 * 只存相机 IP 和可选端口，不存命令、令牌或厂商密钥。文件放在相机目录里
 * 并以点文件形式存在，所以照片列表会跳过它；桥重启时可恢复上次无线目标。
 */
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonCcapiBaseUrl } from './canonCcapiUrl.ts'
import { sonyCameraBaseUrl } from './sonyCameraUrl.ts'

export const CAMERA_RUNTIME_CONFIG_FILE = '.pinkrose-camera.json'

export type CameraControlConfig =
  | { kind: 'none' }
  | { kind: 'gphoto2'; ip: string; port?: string }
  | { kind: 'canon-ccapi'; url: string }
  | { kind: 'sony-camera'; url: string }

/** 校验网页或配置文件送来的相机目标；坏字段一律拒绝。 */
export function parseCameraControlConfig(raw: unknown): CameraControlConfig {
  const body = raw && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : {}
  if (body.kind === 'none') return { kind: 'none' }
  if (body.kind === 'canon-ccapi') {
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
    if (!rawUrl || rawUrl.length > 512) {
      throw new Error('Canon 相机地址不对。填相机 Wi-Fi 地址，例如 192.168.1.50。')
    }
    return { kind: 'canon-ccapi', url: canonCcapiBaseUrl(rawUrl) }
  }
  if (body.kind === 'sony-camera') {
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
    if (!rawUrl || rawUrl.length > 512) {
      throw new Error('Sony 相机地址不对。填相机 Wi-Fi 地址，例如 192.168.1.70。')
    }
    return { kind: 'sony-camera', url: sonyCameraBaseUrl(rawUrl) }
  }
  if (body.kind !== 'gphoto2') {
    throw new Error('只支持 gphoto2、Canon CCAPI、Sony Camera Remote 或断开相机。')
  }
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  if (!ip || ip.length > 253 || /[\s/\\]/.test(ip) || ip.includes('://')) {
    throw new Error('相机 IP 不对。填相机在 Wi-Fi 里的地址，例如 192.168.1.50。')
  }
  const rawPort = typeof body.port === 'string' || typeof body.port === 'number'
    ? String(body.port).trim()
    : ''
  if (rawPort) {
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('相机端口需要 1~65535；不确定就留空。')
    }
  }
  return { kind: 'gphoto2', ip, ...(rawPort ? { port: rawPort } : {}) }
}

export async function loadPersistedCameraControl(
  root: string,
): Promise<CameraControlConfig | null> {
  try {
    const raw = await readFile(join(root, CAMERA_RUNTIME_CONFIG_FILE), 'utf8')
    const config = parseCameraControlConfig(JSON.parse(raw))
    return config.kind === 'none' ? null : config
  } catch {
    return null
  }
}

export async function savePersistedCameraControl(
  root: string, config: CameraControlConfig,
): Promise<void> {
  const file = join(root, CAMERA_RUNTIME_CONFIG_FILE)
  if (config.kind === 'none') {
    await rm(file, { force: true })
    return
  }
  const tmp = join(root, `.pinkrose-camera.${process.pid}.${Date.now()}.tmp`)
  const text = JSON.stringify({ version: 1, ...config })
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => {})
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
