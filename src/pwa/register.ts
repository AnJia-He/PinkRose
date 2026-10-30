/** 只在生产构建调用；开发服务器不注册，避免缓存和热更新打架。 */
export function registerPwa(nav: Navigator = navigator): void {
  if (!('serviceWorker' in nav)) return
  window.addEventListener('load', () => {
    nav.serviceWorker.register('/sw.js').catch(error => {
      console.warn('离线应用壳没启动（不影响在线使用）', error)
    })
  }, { once: true })
}
