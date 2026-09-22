import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端自己的开发/构建配置。**测试配置不在这里**——见仓库根的 vitest.config.ts。
// 原因：测试分布在三个目录（HeadEnd/、BackEnd/、shared/），而 vite 的 root
// 现在就是这个目录；分开之后 vite 管构建、vitest 管测试，互不牵扯。
export default defineConfig({
  plugins: [react()],
  server: {
    // 开发时前端在 5173、后端在 8787。走同源代理，省掉 CORS。
    proxy: { '/api': 'http://localhost:8787' },
  },
})
