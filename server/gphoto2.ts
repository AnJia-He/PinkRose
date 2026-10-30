import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CameraControlProvider,
  CameraControlStatus,
  CameraSettingDescriptor,
  CameraSettings,
  CameraSettingValue,
} from './cameraBridge.ts'

/**
 * gphoto2 相机控制适配器（★ 2026-10-19）。
 *
 * 文件夹桥解决「拍完自动落盘」，这个适配器解决「网页里直接控制相机」。
 * gphoto2 是跨厂商的 USB / PTP 工具，Canon、Nikon、Sony、Fujifilm 等大量机型
 * 都能用；macOS 可 `brew install gphoto2`，Windows 需要先装 libgphoto2 的
 * 可执行文件。它不依赖任何厂商私有 SDK，也不把照片上传到云端。
 *
 * ⚠️ 这里只执行固定子命令，不接收网页传来的任意命令行；参数值会作为
 *   `--set-config key=value` 的一个 argv 传进去，不经过 shell。
 */

export type CameraCommandResult = {
  stdout: Buffer
  stderr: string
}

export type CameraCommandRunner = (
  command: string,
  args: readonly string[],
  timeout: number,
) => Promise<CameraCommandResult>

/** 默认执行器。实时取景的 JPEG 可能超过 1 MB，所以单独把 maxBuffer 放宽。 */
export const defaultCameraCommandRunner: CameraCommandRunner = (
  command, args, timeout,
) => new Promise((resolve, reject) => {
  execFile(
    command,
    [...args],
    { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
    (error, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
      const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          reject(new Error('没找到 gphoto2。先在终端安装 gphoto2，再重启相机桥。'))
          return
        }
        const detail = err.trim()
        reject(new Error(detail ? `${error.message}（${detail}）` : error.message))
        return
      }
      resolve({ stdout: out, stderr: err })
    },
  )
})

/** `gphoto2 --auto-detect` 的输出：表头 + 分隔线 + 一行或多行相机。 */
export function parseGphoto2Detect(text: string): { model: string; port: string } | null {
  const lines = text.split(/\r?\n/)
  const separator = lines.findIndex(line => /^\s*-{3,}/.test(line))
  const rows = (separator >= 0 ? lines.slice(separator + 1) : lines)
    .map(line => line.trimEnd())
    .filter(line => line.trim() && !/^Model\s+Port$/i.test(line.trim()))
  for (const row of rows) {
    const match = row.match(/^(.*?)\s{2,}(\S+:\S+)$/)
    if (match) return { model: match[1]!.trim(), port: match[2]!.trim() }
    if (row.trim()) return { model: row.trim(), port: '' }
  }
  return null
}

export type Gphoto2Config = {
  type: string
  current: string | null
  choices: { value: string; label: string }[]
  bottom: number | null
  top: number | null
  step: number | null
}

/** 解析 `gphoto2 --get-config` 的完整输出（RADIO 选项 / RANGE 范围）。 */
export function parseGphoto2Setting(text: string): Gphoto2Config | null {
  const lines = text.split(/\r?\n/)
  const field = (name: string): string | null => {
    const line = lines.find(item => new RegExp(`^\\s*${name}:\\s*`, 'i').test(item))
    if (!line) return null
    const value = line.replace(new RegExp(`^\\s*${name}:\\s*`, 'i'), '').trim()
    return value || null
  }
  const number = (name: string): number | null => {
    const raw = field(name)
    if (raw === null) return null
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const choices: { value: string; label: string }[] = []
  for (const line of lines) {
    const match = line.match(/^\s*Choice:\s*(\S+)\s+(.+)$/i)
    if (match) choices.push({ value: match[1]!, label: match[2]!.trim() })
  }
  const current = field('Current')
  const type = field('Type')?.toUpperCase() ?? ''
  const bottom = number('Bottom')
  const top = number('Top')
  const step = number('Step')
  if (!type && current === null && choices.length === 0
    && bottom === null && top === null && step === null) return null
  return { type, current, choices, bottom, top, step }
}

/** `--get-config` 的当前值：`Current: 400` / `Current: 1/125`。 */
export function parseGphoto2Config(text: string): string | null {
  return parseGphoto2Setting(text)?.current ?? null
}

/** `gphoto2 --list-config` 的路径列表，取最后一段作为配置名。 */
export function parseGphoto2ConfigList(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const name = trimmed.split('/').filter(Boolean).pop()
    if (name) names.add(name.toLowerCase())
  }
  return names
}

/** 有些 gphoto2 版本会在二进制帧前打一行提示；从 JPEG 的 SOI 标记开始取。 */
export function jpegFromBuffer(buffer: Buffer): Uint8Array | null {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8]))
  if (start < 0) return null
  return new Uint8Array(buffer.subarray(start))
}

const CONFIG_ALIASES = {
  iso: ['iso'],
  shutter: ['shutter-speed', 'shutterspeed'],
  aperture: ['f-number', 'fnumber', 'aperture'],
  whiteBalance: ['whitebalance', 'white-balance'],
  driveMode: ['drivemode', 'drive-mode'],
  metering: ['meteringmode', 'metering-mode', 'metering'],
  exposureCompensation: ['exposurecompensation', 'exposure-compensation'],
  focusMode: ['focusmode', 'focus-mode'],
  imageQuality: ['imagequality', 'image-quality'],
  shootingMode: ['exposureprogram', 'exposure-program', 'capturemode', 'capture-mode'],
  battery: ['batterylevel', 'battery-level'],
  lens: ['lensname', 'lens-name', 'lens'],
} as const

type SettingKey = keyof typeof CONFIG_ALIASES

const FALLBACK_SCHEMA: Partial<Record<SettingKey, CameraSettingDescriptor>> = {
  iso: { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 12800, step: 100 },
  shutter: {
    key: 'shutter', label: '快门', type: 'select',
    options: ['1/60', '1/125', '1/250', '1/500', '1/1000'].map(value => ({
      value, label: value,
    })),
  },
  aperture: {
    key: 'aperture', label: '光圈', type: 'select',
    options: ['2.8', '4', '5.6', '8', '11'].map(value => ({
      value, label: `f/${value}`,
    })),
  },
}

const SETTING_LABELS = {
  iso: 'ISO',
  shutter: '快门',
  aperture: '光圈',
  whiteBalance: '白平衡',
  driveMode: '驱动模式',
  metering: '测光',
  exposureCompensation: '曝光补偿',
  focusMode: '对焦模式',
  imageQuality: '图像质量',
  shootingMode: '拍摄模式',
  battery: '电池',
  lens: '镜头',
} as const

/** 把相机实际返回的选项 / 范围翻成网页动态控件；认不出来就返回 null。 */
export function gphoto2SettingDescriptor(
  key: SettingKey,
  config: Gphoto2Config | null,
): CameraSettingDescriptor | null {
  if (!config) return null
  if (config.choices.length > 0) {
    return {
      key,
      label: SETTING_LABELS[key],
      type: 'select',
      readOnly: key === 'battery' || key === 'lens',
      // `Choice: 0 400` 的前半截是序号，后半截才是 `--set-config` 接受的值。
      // 下拉框用后半截，当前值（Current: 400）才对得上。
      options: config.choices.map(choice => ({
        value: choice.label,
        label: choice.label,
      })),
    }
  }
  if (config.bottom !== null && config.top !== null) {
    return {
      key,
      label: SETTING_LABELS[key],
      type: 'number',
      readOnly: key === 'battery' || key === 'lens',
      min: config.bottom,
      max: config.top,
      step: config.step && config.step > 0 ? config.step : 1,
    }
  }
  return null
}

export type Gphoto2ProviderOptions = {
  /** 快门下载目录；和文件夹桥共用同一个目录。 */
  root: string
  /** 可执行文件名；默认 `gphoto2`。 */
  command?: string
  /**
   * 指定 gphoto2 port（例如 `usb:001,004` 或 `ptpip:192.168.1.50`）。
   * 不传 = 让 gphoto2 自己 auto-detect。
   */
  port?: string
  /** 测试注入点；默认走 `execFile`。 */
  runner?: CameraCommandRunner
  /** 单条命令超时；默认 15 秒。 */
  timeout?: number
  /** 测试注入点，用来生成稳定的快门文件名。 */
  now?: () => number
}

/**
 * 创建一个 gphoto2 控制适配器。没有相机时 `status()` 返回 disconnected，
 * 不让相机桥整个挂掉；实时取景失败时返回 null，网页会显示没有帧。
 */
export function createGphoto2CameraProvider(
  options: Gphoto2ProviderOptions,
): CameraControlProvider {
  const command = options.command ?? 'gphoto2'
  const port = options.port?.trim()
  const run = options.runner ?? defaultCameraCommandRunner
  const timeout = options.timeout ?? 15_000
  const now = options.now ?? Date.now
  let connected = false
  let previewDiagnostic: string | null = null
  let schemaCache: { at: number; schema: CameraSettingDescriptor[] } | null = null
  let configAliases = new Map<SettingKey, string>()

  const call = (args: string[], ms = timeout) =>
    run(command, port ? ['--port', port, ...args] : args, ms)

  const aliasFor = (key: SettingKey, available: Set<string>): string | null => {
    const aliases = CONFIG_ALIASES[key]
    const found = aliases.find(alias => available.has(alias.toLowerCase()))
    if (found) return found
    // 核心三项即使没被列出来也照旧试一次；扩展项只认相机明确列出的。
    return FALLBACK_SCHEMA[key] ? aliases[0] : null
  }

  const loadSchema = async (): Promise<CameraSettingDescriptor[]> => {
    if (schemaCache && Date.now() - schemaCache.at < 30_000) return schemaCache.schema
    let available: Set<string> | null = null
    try {
      const { stdout } = await call(['--list-config'], 8_000)
      available = parseGphoto2ConfigList(stdout.toString('utf8'))
    } catch {
      // 老版本 / 某些驱动不支持 --list-config：退回核心三项。
    }
    const nextAliases = new Map<SettingKey, string>()
    const schema: CameraSettingDescriptor[] = []
    for (const key of Object.keys(CONFIG_ALIASES) as SettingKey[]) {
      const alias = available
        ? aliasFor(key, available)
        : (FALLBACK_SCHEMA[key] ? CONFIG_ALIASES[key][0] : null)
      if (!alias) continue
      nextAliases.set(key, alias)
      let descriptor: CameraSettingDescriptor | null = null
      try {
        const { stdout } = await call(['--get-config', alias], 8_000)
        descriptor = gphoto2SettingDescriptor(key, parseGphoto2Setting(stdout.toString('utf8')))
      } catch {
        // 这一项读不出来就跳过；不阻塞其它参数。
      }
      descriptor ??= FALLBACK_SCHEMA[key] ?? null
      if (descriptor) schema.push(descriptor)
    }
    configAliases = nextAliases
    schemaCache = { at: Date.now(), schema }
    return schema
  }

  const status = async (): Promise<CameraControlStatus> => {
    try {
      const { stdout } = await call(['--auto-detect'], 8_000)
      const found = parseGphoto2Detect(stdout.toString('utf8'))
      connected = !!found
      if (!found) {
        schemaCache = null
        configAliases = new Map()
        previewDiagnostic = null
      }
      const schema = found ? await loadSchema() : []
      return {
        connected,
        model: found?.model ?? null,
        capabilities: found
          ? { liveView: true, shutter: true, settings: true }
          : { liveView: false, shutter: false, settings: false },
        settingsSchema: schema,
        ...(found && previewDiagnostic ? { previewDiagnostic } : {}),
        ...(!found
          ? {
              diagnostic: port?.startsWith('ptpip:')
                ? '连不上无线相机。确认相机已开启 PC Remote / PTP、IP 正确、两台设备在同一 Wi-Fi，并检查电脑防火墙。'
                : 'gphoto2 已运行，但没检测到相机。检查相机电源和 USB 连接，并确认没有别的软件占用相机。',
            }
          : {}),
      }
    } catch (error) {
      connected = false
      schemaCache = null
      configAliases = new Map()
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      const missing = /enoent|没找到 gphoto2|not found|not recognized/.test(message)
      const busy = /could not claim|resource busy|device busy|device or resource busy|error locking|failed to lock/.test(message)
      const network = !!port?.startsWith('ptpip:')
        || /timed out|timeout|etimedout|econnrefused|ehostunreach|network is unreachable|connection refused/.test(message)
      const diagnostic = missing
        ? 'gphoto2 还没安装。macOS 先运行 brew install gphoto2；Windows 安装带 gphoto2 的 libgphoto2，然后重启相机桥。'
        : busy
          ? '相机被别的程序占用，或 USB 连接没有交给相机桥。关掉 EOS Utility / Imaging Edge / Capture One 等软件，换一根数据线后再试。'
          : network
            ? '连不上无线相机。确认相机已开启 PC Remote / PTP、IP 正确、两台设备在同一 Wi-Fi，并检查电脑防火墙。'
            : '相机连接失败。确认相机已开机、连接模式正确，并检查 gphoto2 是否可用。'
      return {
        connected: false,
        model: null,
        capabilities: { liveView: false, shutter: false, settings: false },
        settingsSchema: [],
        ...(diagnostic ? { diagnostic } : {}),
      }
    }
  }

  const readSetting = async (key: SettingKey): Promise<CameraSettingValue | null> => {
    if (configAliases.size === 0) await loadSchema()
    const alias = configAliases.get(key)
    if (!alias) return null
    try {
      const { stdout } = await call(['--get-config', alias], 8_000)
      const raw = parseGphoto2Config(stdout.toString('utf8'))
      if (raw === null) return null
      const descriptor = schemaCache?.schema.find(item => item.key === key)
      if (key === 'iso' || descriptor?.type === 'number') {
        const number = Number(raw)
        return Number.isFinite(number) ? number : raw
      }
      return raw
    } catch {
      return null
    }
  }

  const readAllSettings = async (): Promise<CameraSettings> => {
    if (configAliases.size === 0) await loadSchema()
    const settings: CameraSettings = {}
    // 顺序读：同一台相机上并发开多个 gphoto2 进程容易抢 PTP 锁。
    for (const key of Object.keys(CONFIG_ALIASES) as SettingKey[]) {
      const value = await readSetting(key)
      if (value !== null) settings[key] = value
    }
    return settings
  }

  return {
    status,
    liveView: async () => {
      if (!connected) await status()
      if (!connected) return null
      try {
        const { stdout } = await call(['--capture-preview', '--stdout'], 10_000)
        const frame = jpegFromBuffer(stdout)
        if (!frame) {
          previewDiagnostic = '实时取景没拿到画面。确认相机支持预览，并退出相机上的回放模式后再试。'
          return null
        }
        previewDiagnostic = null
        return frame
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : ''
        const busy = /could not claim|resource busy|device busy|device or resource busy|error locking|failed to lock/.test(message)
        previewDiagnostic = busy
          ? '实时取景被别的程序占用。关掉 EOS Utility / Imaging Edge / Capture One 等软件，再试一次。'
          : '实时取景没拿到画面。确认相机还连着、支持实时预览，并退出相机上的回放模式后再试。'
        return null
      }
    },
    capture: async () => {
      const stamp = now()
      const prefix = join(options.root, `pinkrose-${stamp}`)
      await call(['--capture-image-and-download', '--filename', prefix], 30_000)
      // gphoto2 会自己补扩展名（JPG / CR3 / NEF…），按前缀找刚下载的那个。
      const entries = await readdir(options.root, { withFileTypes: true }).catch(() => [])
      let saved: string | null = null
      let savedMtime = -Infinity
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(`pinkrose-${stamp}`)) continue
        const info = await stat(join(options.root, entry.name)).catch(() => null)
        if (info && info.mtimeMs >= savedMtime) {
          saved = entry.name
          savedMtime = info.mtimeMs
        }
      }
      return saved ? { saved } : {}
    },
    getSettings: readAllSettings,
    setSettings: async patch => {
      if (configAliases.size === 0) await loadSchema()
      for (const [key, value] of Object.entries(patch)) {
        const settingKey = key as SettingKey
        const alias = configAliases.get(settingKey)
        if (!alias) continue
        if (schemaCache?.schema.find(item => item.key === settingKey)?.readOnly) continue
        await call(['--set-config', `${alias}=${value}`], 8_000)
      }
      return readAllSettings()
    },
  }
}
