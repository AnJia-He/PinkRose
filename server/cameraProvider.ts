/**
 * **相机控制适配器的加载点**（★ 2026-10-19）。
 *
 * 文件夹桥 / gphoto2 之外，厂商 SDK（Canon EDSDK、Nikon SDK、Sony Camera Remote
 * SDK、Fujifilm 等）需要一个正式的接入位置。这里把「用哪个 provider」从
 * `scripts/camera-bridge.ts` 里抽出来，支持：
 *
 *   npm run camera:bridge -- --provider ./my-canon-adapter.mjs
 *
 * 适配器模块导出 `createCameraProvider({ root })`（或 `createProvider` /
 * 默认函数），返回一个 `CameraControlProvider`。主程序和网页都不用改。
 *
 * ⚠️ 适配器是**本机 Node 模块**，拥有完整进程权限 —— 只加载自己信任的代码。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createMockCameraProvider, type CameraControlProvider, type CameraControlStatus,
  type CameraSettingDescriptor, type CameraSettings,
} from './cameraBridge.ts'
import { createCanonCcapiCameraProvider } from './canonCcapi.ts'
import { createGphoto2CameraProvider } from './gphoto2.ts'
import { createSonyCameraProvider } from './sonyCamera.ts'

export type CameraProviderSpec =
  | { kind: 'none' }
  | { kind: 'mock'; source: string }
  | { kind: 'gphoto2'; command: string; port?: string }
  | { kind: 'canon-ccapi'; url: string }
  | { kind: 'sony-camera'; url: string }
  | { kind: 'module'; path: string }

export type CameraProviderDeps = {
  root: string
  /** 测试用：替换动态 import。 */
  importModule?: (url: string) => Promise<unknown>
  createMock?: (source: string, root: string) => CameraControlProvider
  createGphoto?: (opts: { root: string; command: string; port?: string }) => CameraControlProvider
  createCanon?: (opts: { root: string; url: string }) => CameraControlProvider
  createSony?: (opts: { root: string; url: string }) => CameraControlProvider
}

type Factory = (opts: { root: string }) => unknown

type ProviderGuardOptions = {
  statusMs?: number
  liveViewMs?: number
  captureMs?: number
  importMs?: number
  settingsMs?: number
}

function findFactory(mod: unknown): Factory | null {
  if (typeof mod === 'function') return mod as Factory
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null
  const m = mod as Record<string, unknown>
  // 直接导出 provider 对象（CommonJS 适配器常见）。
  if (typeof m.status === 'function') return () => m
  for (const key of ['createCameraProvider', 'createProvider', 'default']) {
    const value = m[key]
    if (typeof value === 'function') return value as Factory
  }
  // 默认导出一个现成对象也接受（方便最简单的一次性适配器）。
  const fallback = m.default
  if (fallback && typeof fallback === 'object'
    && typeof (fallback as { status?: unknown }).status === 'function') {
    return () => fallback
  }
  return null
}

function assertProvider(value: unknown): CameraControlProvider {
  if (!value || typeof value !== 'object'
    || typeof (value as { status?: unknown }).status !== 'function') {
    throw new Error('相机适配器必须返回一个带 status() 的对象')
  }
  return value as CameraControlProvider
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function shortText(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string') throw new Error(`相机适配器的 ${field} 必须是文字`)
  const text = value.trim()
  if (!text || text.length > max) throw new Error(`相机适配器的 ${field} 长度不对`)
  return text
}

function normalizeSchema(value: unknown): CameraSettingDescriptor[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('相机适配器的 settingsSchema 必须是数组，且不能超过 128 项')
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`相机适配器的第 ${index + 1} 个参数描述格式不对`)
    }
    const item = raw as Record<string, unknown>
    const key = shortText(item.key, '参数 key', 64)
    const label = shortText(item.label, '参数 label', 80)
    if (item.type !== 'number' && item.type !== 'select') {
      throw new Error(`相机适配器的参数 ${key} 类型必须是 number 或 select`)
    }
    if (item.type === 'select') {
      if (!Array.isArray(item.options) || item.options.length === 0 || item.options.length > 512) {
        throw new Error(`相机适配器的参数 ${key} 必须提供 1–512 个选项`)
      }
      return {
        key,
        label,
        type: 'select',
        ...(item.readOnly === true ? { readOnly: true } : {}),
        options: item.options.map((option, optionIndex) => {
          if (!option || typeof option !== 'object' || Array.isArray(option)) {
            throw new Error(`相机适配器的参数 ${key} 第 ${optionIndex + 1} 个选项格式不对`)
          }
          const choice = option as Record<string, unknown>
          return {
            value: shortText(choice.value, `${key} 选项值`, 120),
            label: shortText(choice.label, `${key} 选项名`, 120),
          }
        }),
      }
    }
    const min = Number(item.min)
    const max = Number(item.max)
    const step = item.step === undefined ? 1 : Number(item.step)
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)
      || min > max || step <= 0) {
      throw new Error(`相机适配器的参数 ${key} 数值范围不对`)
    }
    return {
      key,
      label,
      type: 'number',
      ...(item.readOnly === true ? { readOnly: true } : {}),
      min,
      max,
      step,
    }
  })
}

export function normalizeCameraStatus(value: unknown): CameraControlStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('相机适配器的 status() 必须返回对象')
  }
  const status = value as Record<string, unknown>
  if (typeof status.connected !== 'boolean') {
    throw new Error('相机适配器的 status() 必须给出 connected 布尔值')
  }
  if (status.model !== null && typeof status.model !== 'string') {
    throw new Error('相机适配器的 model 必须是文字或 null')
  }
  if (!status.capabilities || typeof status.capabilities !== 'object'
    || Array.isArray(status.capabilities)) {
    throw new Error('相机适配器必须给出 capabilities')
  }
  const caps = status.capabilities as Record<string, unknown>
  for (const key of ['liveView', 'shutter', 'settings']) {
    if (typeof caps[key] !== 'boolean') {
      throw new Error(`相机适配器的 capabilities.${key} 必须是布尔值`)
    }
  }
  if (caps.import !== undefined && typeof caps.import !== 'boolean') {
    throw new Error('相机适配器的 capabilities.import 必须是布尔值')
  }
  const schema = normalizeSchema(status.settingsSchema)
  const diagnostic = status.diagnostic === undefined ? null
    : status.diagnostic === null ? null : shortText(status.diagnostic, 'diagnostic', 500)
  const previewDiagnostic = status.previewDiagnostic === undefined ? null
    : status.previewDiagnostic === null ? null
      : shortText(status.previewDiagnostic, 'previewDiagnostic', 500)
  return {
    connected: status.connected,
    model: status.model === null ? null : status.model.trim().slice(0, 120) || null,
    capabilities: {
      liveView: caps.liveView as boolean,
      shutter: caps.shutter as boolean,
      settings: caps.settings as boolean,
      ...(caps.import === true ? { import: true } : {}),
    },
    settingsSchema: schema,
    ...(diagnostic ? { diagnostic } : {}),
    ...(previewDiagnostic ? { previewDiagnostic } : {}),
  }
}

export function normalizeCameraSettings(value: unknown): CameraSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('相机适配器返回的参数必须是对象')
  }
  const out: CameraSettings = {}
  for (const [key, raw] of Object.entries(value).slice(0, 128)) {
    const safeKey = shortText(key, '参数 key', 64)
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) throw new Error(`相机参数 ${safeKey} 不是有限数字`)
      out[safeKey] = raw
    } else if (typeof raw === 'string' && raw.length <= 240) {
      out[safeKey] = raw
    } else {
      throw new Error(`相机参数 ${safeKey} 只能是文字或数字`)
    }
  }
  return out
}

export function normalizeLiveViewFrame(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null
  if (!(value instanceof Uint8Array) || value.length < 4 || value.length > 16 * 1024 * 1024) {
    throw new Error('相机实时取景返回的不是有效图片字节')
  }
  const jpeg = value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff
  const png = value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47
  if (!jpeg && !png) throw new Error('相机实时取景只接受 JPEG 或 PNG')
  return value
}

function normalizeCaptureResult(value: unknown): { saved?: string } | void {
  if (value === undefined || value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('相机快门返回值必须是对象')
  }
  const saved = (value as Record<string, unknown>).saved
  if (saved === undefined) return {}
  if (typeof saved !== 'string' || !saved.trim() || saved.length > 240
    || /[\\/]/.test(saved) || saved === '.' || saved === '..') {
    throw new Error('相机快门返回的文件名不合法')
  }
  return { saved: saved.trim() }
}

function normalizeImportResult(value: unknown): { imported: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('相机导入返回值必须是对象')
  }
  const imported = (value as Record<string, unknown>).imported
  if (!Array.isArray(imported) || imported.length > 100) {
    throw new Error('相机导入结果必须包含最多 100 个文件名')
  }
  return {
    imported: [...new Set(imported.map(item => {
      if (typeof item !== 'string' || !item.trim() || item.length > 240
        || /[\\/]/.test(item) || item === '.' || item === '..') {
        throw new Error('相机导入结果里的文件名不合法')
      }
      return item.trim()
    }))],
  }
}

/**
 * 厂商 SDK 适配器与网页之间的统一契约层。适配器可以自由返回，但只有通过
 * 体积、字段、文件名和超时校验的值才会进入相机桥。
 */
export function guardCameraProvider(
  provider: CameraControlProvider,
  options: ProviderGuardOptions = {},
): CameraControlProvider {
  const statusMs = options.statusMs ?? 8_000
  const liveViewMs = options.liveViewMs ?? 10_000
  const captureMs = options.captureMs ?? 30_000
  const importMs = options.importMs ?? 120_000
  const settingsMs = options.settingsMs ?? 8_000
  return {
    status: async () => normalizeCameraStatus(
      await timeout(provider.status(), statusMs, '相机适配器读取状态超时'),
    ),
    ...(provider.liveView ? {
      liveView: async () => normalizeLiveViewFrame(
        await timeout(provider.liveView!(), liveViewMs, '相机实时取景超时'),
      ),
    } : {}),
    ...(provider.capture ? {
      capture: async () => normalizeCaptureResult(
        await timeout(provider.capture!(), captureMs, '相机快门响应超时'),
      ),
    } : {}),
    ...(provider.importRecent ? {
      importRecent: async limit => normalizeImportResult(
        await timeout(
          provider.importRecent!(Math.max(1, Math.min(100, Math.trunc(limit)))),
          importMs,
          '相机照片导入超时',
        ),
      ),
    } : {}),
    ...(provider.getSettings ? {
      getSettings: async () => normalizeCameraSettings(
        await timeout(provider.getSettings!(), settingsMs, '相机参数读取超时'),
      ),
    } : {}),
    ...(provider.setSettings ? {
      setSettings: async patch => normalizeCameraSettings(
        await timeout(
          provider.setSettings!(normalizeCameraSettings(patch)),
          settingsMs,
          '相机参数写入超时',
        ),
      ),
    } : {}),
  }
}

/**
 * 按用户选择创建 provider。没有接可控相机时返回 null（文件夹桥照常工作）。
 * 所有失败都抛**能照着做**的中文错误，由 CLI 打印后退出。
 */
export async function loadCameraProvider(
  spec: CameraProviderSpec, deps: CameraProviderDeps,
): Promise<CameraControlProvider | null> {
  const { root } = deps
  if (spec.kind === 'none') return null
  if (spec.kind === 'mock') {
    const make = deps.createMock ?? createMockCameraProvider
    return guardCameraProvider(assertProvider(make(spec.source, root)))
  }
  if (spec.kind === 'gphoto2') {
    const make = deps.createGphoto ?? createGphoto2CameraProvider
    return guardCameraProvider(assertProvider(make({
      root, command: spec.command,
      ...(spec.port ? { port: spec.port } : {}),
    })))
  }
  if (spec.kind === 'canon-ccapi') {
    const make = deps.createCanon ?? createCanonCcapiCameraProvider
    return guardCameraProvider(assertProvider(make({
      root,
      url: spec.url,
    })))
  }
  if (spec.kind === 'sony-camera') {
    const make = deps.createSony ?? createSonyCameraProvider
    return guardCameraProvider(assertProvider(make({
      root,
      url: spec.url,
    })))
  }

  const file = resolve(spec.path)
  if (!existsSync(file)) {
    throw new Error(`相机适配器文件不存在：${file}`)
  }
  let mod: unknown
  try {
    const url = pathToFileURL(file).href
    mod = deps.importModule
      ? await deps.importModule(url)
      : await import(url)
  } catch (e) {
    const detail = e instanceof Error ? `（${e.message}）` : ''
    throw new Error(`相机适配器加载失败${detail}。检查文件路径和 import 语法。`)
  }
  const factory = findFactory(mod)
  if (!factory) {
    throw new Error(
      '相机适配器必须导出 createCameraProvider({ root })（或 createProvider / 默认函数），'
      + '并返回带 status() 的对象。',
    )
  }
  let provider: unknown
  try {
    provider = await factory({ root })
  } catch (e) {
    const detail = e instanceof Error ? `（${e.message}）` : ''
    throw new Error(`相机适配器启动失败${detail}。确认相机已连接、SDK 已初始化。`)
  }
  return guardCameraProvider(assertProvider(provider))
}
