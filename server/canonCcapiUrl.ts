/**
 * Normalize a Canon CCAPI endpoint without accepting credentials or custom
 * protocols. Shared by the provider and the persisted web configuration.
 */
export function canonCcapiBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Canon CCAPI 地址为空')
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('Canon CCAPI 地址不对，示例：192.168.1.50 或 http://192.168.1.50:8080')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Canon CCAPI 只支持 http:// 或 https:// 地址')
  }
  if (url.username || url.password) {
    throw new Error('Canon CCAPI 地址里不要放用户名或密码')
  }
  if (!url.port) url.port = '8080'
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
