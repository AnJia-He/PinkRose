/**
 * Sony Camera Remote API HTTP endpoint. Most bodies expose port 10000.
 */
export function sonyCameraBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Sony 相机地址为空')
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('Sony 相机地址不对，示例：192.168.1.70 或 http://192.168.1.70:10000')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Sony Camera Remote API 只支持 http:// 或 https:// 地址')
  }
  if (url.username || url.password) {
    throw new Error('Sony 相机地址里不要放用户名或密码')
  }
  if (!url.port) url.port = '10000'
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/sony$/i, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
