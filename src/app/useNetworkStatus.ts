import { useEffect, useState } from 'react'

/**
 * 浏览器给出的粗粒度在线状态。`navigator.onLine === false` 可以确定离线；
 * `true` 只表示有网络接口，不保证服务器可达，所以这里只负责提示，不用它
 * 静默拦截用户操作。真正的服务失败仍由各条请求自己说人话。
 */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  )
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    setOnline(navigator.onLine !== false)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
