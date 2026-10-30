import { existsSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import {
  createCameraBridgeServer, detectCameraConverters,
} from '../server/cameraBridge.ts'
import {
  loadCameraProvider, type CameraProviderSpec,
} from '../server/cameraProvider.ts'
import { auditCameraProvider } from '../server/cameraProviderAudit.ts'
import { loadPersistedCameraControl } from '../server/cameraRuntimeConfig.ts'

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const root = resolve(
  arg('--dir')
  ?? process.env.CAMERA_WATCH_DIR
  ?? resolve(process.cwd(), 'captures'),
)
mkdirSync(root, { recursive: true })

const port = Number(arg('--port') ?? process.env.CAMERA_BRIDGE_PORT ?? 8788)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('端口不对：--port 需要 1~65535 的整数。')
  process.exit(1)
}

const host = (arg('--host') ?? process.env.CAMERA_BRIDGE_HOST ?? '127.0.0.1').trim()
const localOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1'
let token = (arg('--token') ?? process.env.CAMERA_BRIDGE_TOKEN ?? '').trim()
if (!localOnly && !token) {
  // 跨设备访问必须默认有认证；随机生成一个，用户不用自己发明。
  token = randomBytes(18).toString('base64url')
}
if (token && token.length < 8) {
  console.error('访问令牌太短：至少 8 个字符。建议直接用 --host 0.0.0.0 让程序自动生成。')
  process.exit(1)
}

const extraOrigins = (process.env.CAMERA_BRIDGE_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  ...extraOrigins,
]

const converters = await detectCameraConverters()
const mockLive = arg('--mock-live')
const mockSource = mockLive ? resolve(mockLive) : null
if (mockSource && !existsSync(mockSource)) {
  console.error(`模拟取景文件不存在：${mockSource}`)
  process.exit(1)
}
const gphotoCommandArg = arg('--gphoto2-command') ?? process.env.GPHOTO2_COMMAND
const gphotoCommand = gphotoCommandArg ?? 'gphoto2'
const gphotoIp = (arg('--gphoto2-ip') ?? process.env.GPHOTO2_IP ?? '').trim()
const gphotoPort = (arg('--gphoto2-port') ?? process.env.GPHOTO2_PORT ?? '').trim()
  || (gphotoIp ? `ptpip:${gphotoIp}` : '')
const canonCcapiUrl = (arg('--canon-ccapi') ?? process.env.CANON_CCAPI_URL ?? '').trim()
const sonyCameraUrl = (arg('--sony-camera') ?? process.env.SONY_CAMERA_URL ?? '').trim()
const providerHint = (process.env.CAMERA_BRIDGE_PROVIDER ?? '').trim().toLowerCase()
// 只要给了 gphoto2 相关的 IP / port / command，就自动启用 gphoto2；
// 用户不必为了无线相机再多记一个 --gphoto2。
const useGphoto = process.argv.includes('--gphoto2')
  || providerHint === 'gphoto2'
  || !!gphotoCommandArg || !!gphotoIp || !!gphotoPort
const useCanonCcapi = !!canonCcapiUrl || providerHint === 'canon-ccapi'
if (useCanonCcapi && !canonCcapiUrl) {
  console.error('Canon CCAPI 缺少地址：加 --canon-ccapi 192.168.1.50，或设置 CANON_CCAPI_URL。')
  process.exit(1)
}
const useSonyCamera = !!sonyCameraUrl || providerHint === 'sony-camera'
if (useSonyCamera && !sonyCameraUrl) {
  console.error('Sony Camera Remote 缺少地址：加 --sony-camera 192.168.1.70，或设置 SONY_CAMERA_URL。')
  process.exit(1)
}
const providerModule = (arg('--provider') ?? process.env.CAMERA_BRIDGE_PROVIDER_MODULE ?? '').trim()
let spec: CameraProviderSpec = providerModule
  ? { kind: 'module', path: providerModule }
  : mockSource
    ? { kind: 'mock', source: mockSource }
    : useCanonCcapi
      ? { kind: 'canon-ccapi', url: canonCcapiUrl }
      : useSonyCamera
        ? { kind: 'sony-camera', url: sonyCameraUrl }
        : useGphoto
          ? { kind: 'gphoto2', command: gphotoCommand, ...(gphotoPort ? { port: gphotoPort } : {}) }
          : { kind: 'none' }
let restoredWireless = false
if (spec.kind === 'none') {
  const persisted = await loadPersistedCameraControl(root)
  if (persisted?.kind === 'gphoto2') {
    restoredWireless = true
    spec = {
      kind: 'gphoto2',
      command: gphotoCommand,
      port: `ptpip:${persisted.ip}${persisted.port ? `:${persisted.port}` : ''}`,
    }
  } else if (persisted?.kind === 'canon-ccapi') {
    restoredWireless = true
    spec = { kind: 'canon-ccapi', url: persisted.url }
  } else if (persisted?.kind === 'sony-camera') {
    restoredWireless = true
    spec = { kind: 'sony-camera', url: persisted.url }
  }
}
let control
try {
  control = await loadCameraProvider(spec, { root })
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
const configureControl = !providerModule && !mockSource
  ? async (config: {
    kind: 'none'
  } | {
    kind: 'gphoto2'; ip: string; port?: string
  } | {
    kind: 'canon-ccapi'; url: string
  } | {
    kind: 'sony-camera'; url: string
  }) => {
    if (config.kind === 'none') return null
    if (config.kind === 'canon-ccapi') {
      return loadCameraProvider({
        kind: 'canon-ccapi',
        url: config.url,
      }, { root })
    }
    if (config.kind === 'sony-camera') {
      return loadCameraProvider({
        kind: 'sony-camera',
        url: config.url,
      }, { root })
    }
    const wirelessPort = config.port
      ? `ptpip:${config.ip}:${config.port}`
      : `ptpip:${config.ip}`
    return loadCameraProvider({
      kind: 'gphoto2',
      command: gphotoCommand,
      port: wirelessPort,
    }, { root })
  }
  : undefined
if (process.argv.includes('--probe')) {
  if (!control) {
    console.error(
      '没有可控相机：用 --gphoto2 / --gphoto2-ip、--canon-ccapi、--sony-camera 或 --provider 指定一个适配器。',
    )
    process.exit(1)
  }
  try {
    const report = await auditCameraProvider(control, {
      liveView: true,
      settings: true,
      writeSettings: process.argv.includes('--probe-write'),
    })
    console.log(`  探针目标：${spec.kind}${
      spec.kind === 'gphoto2' && gphotoPort ? `，port=${gphotoPort}` : ''
    }${spec.kind === 'canon-ccapi' || spec.kind === 'sony-camera' ? `，url=${spec.url}` : ''}`)
    console.log(JSON.stringify(report, null, 2))
    if (!report.status.connected) {
      console.error('相机没有连上。检查相机电源、USB / PTP/IP 模式、IP 与防火墙；gphoto2 还需确认已安装。')
      process.exit(1)
    }
    if (!report.ok) {
      console.error('适配器体检有失败项。按上面每项的说明修正后重跑；加 --probe-write 才会测试参数写回。')
      process.exit(1)
    }
    console.log(`  体检通过：${report.checks.length} 项，未按快门、未修改相机参数${process.argv.includes('--probe-write') ? '（写回使用原值）' : ''}。`)
    process.exit(0)
  } catch (e) {
    console.error(`探针失败：${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
const server = createCameraBridgeServer({
  root, allowedOrigins, converters, control, token,
  ...(configureControl ? { configureControl } : {}),
})
server.listen(port, host, () => {
  console.log('')
  console.log(localOnly
    ? '  PinkRose 相机桥已启动（只听本机）'
    : '  PinkRose 相机桥已启动（局域网可访问，带访问令牌）')
  console.log(`  监听：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`)
  if (token) {
    console.log(`  访问令牌：${token}`)
    console.log('  手机 / iPad 连接时，在网页「相机桥」里填入上面的令牌。')
  }
  if (!localOnly) {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(item => item?.family === 'IPv4' && !item.internal)
      .map(item => item!.address)
    for (const address of addresses) {
      console.log(`  同一 Wi-Fi 下可访问：http://${address}:${port}`)
    }
    if (addresses.length === 0) {
      console.log('  没有找到局域网 IPv4 地址；确认电脑和手机在同一 Wi-Fi。')
    }
  }
  console.log(`  相机保存目录：${root}`)
  console.log('')
  console.log('  把相机 tether 软件（EOS Utility / Imaging Edge / Camera Control Pro / Capture One）')
  console.log('  的保存目录设成上面这个目录，网页里点「相机桥」连接即可。')
  console.log('  支持 JPG / PNG / WebP / HEIC / HEIF / TIFF 和常见 RAW 后缀；')
  console.log(converters.length
    ? `  已找到转换器：${converters.map(converter => converter.kind).join(' / ')}，RAW / HEIC / TIFF 会按格式转成 JPG 导入。`
    : '  没找到 RawTherapee / darktable / LibRaw / sips / magick：RAW / HEIC 能否直接打开取决于浏览器。')
  if (providerModule) {
    console.log(`  相机控制：自定义适配器 ${resolve(providerModule)}`)
    console.log('  适配器返回 status()/liveView()/capture()/getSettings()/setSettings() 就会出现在网页里。')
  } else if (mockSource) {
    console.log(`  开发模式实时取景：${mockSource}（按快门会把它复制到相机目录）`)
  } else if (spec.kind === 'gphoto2') {
    const activePort = spec.port ?? ''
    console.log(`  相机控制：gphoto2（${gphotoCommand}${activePort ? `，port=${activePort}` : '，USB auto-detect'}）`)
    console.log('  需要本机先装好 gphoto2；USB 连上相机后，网页会显示实时取景 / 拍一张 / 参数控制。')
    if (restoredWireless) {
      console.log(`  已恢复上次无线相机配置：${activePort}`)
      console.log('  连不上时重新检查相机 IP、PC Remote / PTP 模式和电脑防火墙。')
    } else if (gphotoIp) {
      console.log(`  无线 PTP/IP：相机进入 PC Remote / PTP 模式并与电脑同一 Wi-Fi，使用 ${activePort}。`)
      console.log('  连不上时先检查相机是否允许 PC Remote、电脑防火墙和 IP；不是所有机型都开放 PTP/IP。')
    } else {
      console.log('  无线相机可用 --gphoto2-ip <相机IP>（或 GPHOTO2_IP）走 PTP/IP。')
    }
  } else if (spec.kind === 'canon-ccapi') {
    console.log(`  相机控制：Canon CCAPI（${spec.url}）`)
    if (restoredWireless) console.log('  已恢复上次保存的 Canon CCAPI 地址。')
    console.log('  先在相机菜单启用「Camera Control API」，电脑需与相机在同一网络。')
    console.log('  网页会显示实时取景、快门和相机实际支持的曝光参数；拍完会尝试自动取回新照片。')
    console.log('  CCAPI 仍需用真实 Canon 机型验收；连不上时先查相机 IP、无线设置和电脑防火墙。')
  } else if (spec.kind === 'sony-camera') {
    console.log(`  相机控制：Sony Camera Remote（${spec.url}）`)
    if (restoredWireless) console.log('  已恢复上次保存的 Sony Camera Remote 地址。')
    console.log('  在相机里打开 Wi-Fi「遥控拍摄」/ Smart Remote Control，电脑加入相机的 Wi-Fi。')
    console.log('  网页会显示实时取景、快门和相机当前允许修改的曝光参数；拍完会下载照片到桥目录。')
    console.log('  Sony 旧版 Camera Remote API 仍需用真实机型验收；新机型可能只提供厂商私有 SDK。')
  } else {
    console.log('  相机控制：未预装。网页「相机桥」里可切换无线 gphoto2、Canon CCAPI 或 Sony Camera Remote。')
  }
  console.log('')
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
