import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端自己的开发/构建配置。**测试配置不在这里**——见仓库根的 vitest.config.ts。
// 原因：测试分布在 HeadEnd/（含它里面的 BackEnd/）和 shared/，而 vite 的 root
// 现在就是这个目录；分开之后 vite 管构建、vitest 管测试，互不牵扯。
export default defineConfig({
  plugins: [react()],
  server: {
    // 开发时前端在 5173、后端在 8787。走同源代理，省掉 CORS。
    proxy: { '/api': 'http://localhost:8787' },
    fs: {
      // 后端的代码住在这个 root 里面（HeadEnd/BackEnd/），而 dev 服务器默认会把
      // root 下任何文件按 URL 发出去——不挡的话，浏览器能直接读到后端源码
      // （实测 `/BackEnd/index.ts` 返回 200 加真实源码）。里面没有密钥
      // （.env 在仓库根，不在这儿），但不该让它露出来。
      // 前四项是 vite 原本的默认值，写出来是因为设了 deny 会覆盖掉默认值。
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/BackEnd/**'],
    },
  },
})
