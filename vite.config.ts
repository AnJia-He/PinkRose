import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发时前端在 5173、后端在 8787。走同源代理，省掉 CORS。
    // 用 127.0.0.1 而不是 localhost：后者在 Windows 上可能先解析成 IPv6 的 ::1，
    // 而后端绑的是 IPv4，会连不上。
    proxy: { '/api': 'http://127.0.0.1:8787' },
    // 让手机能连上来试（同一个 wifi 下用电脑的局域网地址打开）。
    // 后端只听本机，所以放行 5173 这个口不会把"花真钱"的那条路暴露出去。
    host: true,
    fs: {
      // 后端代码就在这个根目录下面（server/），而 dev 服务器默认会把 root 下任何
      // 文件按 URL 发出去 —— 不挡的话浏览器能直接读到后端源码。里面没有密钥
      // （.env 在下面这份默认名单里），但不该让它露出来。
      // 前四项是 vite 原本的默认值，写出来是因为设了 deny 会覆盖掉默认值。
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/**'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // 三条线各自的测试都在这儿：前端 src/、后端 server/、共用 shared/
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
  },
})
