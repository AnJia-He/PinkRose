/*
 * PinkRose 离线应用壳（★ 2026-10-19）。
 *
 * 只缓存页面和静态资源，**不缓存 /api/**：账号、照片、会话都从网络现取，
 * 不在 Cache Storage 里留一份副本。离线重开时至少能加载应用壳；本地已打开
 * 的页面继续修图不依赖这个 worker。
 */
const CACHE = 'pinkrose-shell-v2'
const SHELL = [
  '/',
  '/app.html',
  '/manifest.webmanifest',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/apple-touch-icon.png',
]

/**
 * 首次加载时 worker 还没接管页面，浏览器不会把入口脚本和样式交给 fetch 缓存。
 * 安装阶段从应用壳 HTML 里把 `/assets/` 下的入口资源一并抓下来，断网刷新才有
 * 能跑起来的 React，而不是一个空 `#root`。
 */
async function cacheAppAssets(cache) {
  const shell = await cache.match('/app.html')
  if (!shell) return
  const html = await shell.text()
  const paths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
    .map(match => match[1])
  await Promise.allSettled([...new Set(paths)].map(path => cache.add(path)))
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.allSettled(SHELL.map(url => cache.add(url)))
    await cacheAppAssets(cache)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const isAppPath = url.pathname === '/app' || url.pathname.startsWith('/app/')
        || url.pathname === '/works' || url.pathname.startsWith('/works/')
      const fallback = isAppPath ? '/app.html' : '/'
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE)
          cache.put(request, response.clone())
        }
        return response
      } catch {
        return (await caches.match(request))
          || (await caches.match(fallback))
          || (await caches.match('/app.html'))
          || (await caches.match('/'))
          || new Response('PinkRose 暂时离线，联网后再试。', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
      }
    })())
    return
  }

  const cacheable = ['script', 'style', 'font', 'image', 'manifest']
    .includes(request.destination)
  if (!cacheable) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(request)
    const network = fetch(request).then(response => {
      if (response.ok) cache.put(request, response.clone())
      return response
    }).catch(() => null)
    return cached || (await network) || new Response('', { status: 504 })
  })())
})
