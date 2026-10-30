/**
 * 相机桥配对链接（★ 2026-10-19）。
 *
 * iPad / iPhone 上手动输入局域网地址和一长串访问令牌很难用。配对链接把两者
 * 放进 URL 的 **hash**（不会发给服务器），打开网页后点「相机桥」即可自动填好
 * 并连接；读完立刻从地址栏清掉，避免令牌长期留在历史里。
 *
 * ⚠️ 链接本身包含访问令牌：只通过可信渠道发给自己的设备，别公开或截图外传。
 */
export type CameraPairing = {
  address: string
  token: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** 地址归一化：补 http://，只接受 http/https，去掉尾部斜杠。 */
export function normalizeBridgeAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // 明确写了别的协议就拒绝；不要把它当成"主机名 ftp"再补 http。
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const raw = hasScheme ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * 在电脑上生成给 iPad / iPhone 打开的配对链接。
 *
 * 如果当前网页是 localhost（电脑本机打开），而桥是局域网地址，就把网页主机名
 * 换成桥的主机名，端口仍用网页自己的端口 —— 常见开发布局是同一台电脑上的
 * `:5173` 网页 + `:8788` 桥。
 */
export function buildCameraPairingLink(input: {
  appUrl: string
  bridgeAddress: string
  token: string
}): string | null {
  const token = input.token.trim()
  if (!token || token.length > 4096) return null
  const bridgeAddress = normalizeBridgeAddress(input.bridgeAddress)
  if (!bridgeAddress) return null

  let app: URL
  let bridge: URL
  try {
    app = new URL(input.appUrl)
    bridge = new URL(bridgeAddress)
  } catch {
    return null
  }
  if (app.protocol !== 'http:' && app.protocol !== 'https:') return null

  if (LOCAL_HOSTS.has(app.hostname) && !LOCAL_HOSTS.has(bridge.hostname)) {
    app.hostname = bridge.hostname
  }
  app.hash = new URLSearchParams({ camera: bridgeAddress, token }).toString()
  return app.toString()
}

/** 从 URL hash 里读出配对信息；坏数据 / 缺字段一律回 null。 */
export function readCameraPairingHash(hash: string): CameraPairing | null {
  const raw = hash.replace(/^#/, '')
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const address = normalizeBridgeAddress(params.get('camera') ?? '')
  const token = (params.get('token') ?? '').trim()
  if (!address || !token || token.length > 4096) return null
  return { address, token }
}

/** 清掉地址栏里的配对参数，保留路径和普通查询参数。 */
export function clearCameraPairingHash(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  if (!location.hash.includes('camera=')) return
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch {
    // 个别嵌入式浏览器不让改历史；不影响已经读到的连接信息。
  }
}
