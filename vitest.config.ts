import { defineConfig } from 'vitest/config'

// 测试配置独立放在仓库根，不跟前端的 vite 配置混在一起。
// 测试分布在三个目录：HeadEnd/（前端）、BackEnd/（后端）、shared/（共用），
// 而前端那套的 root 在 HeadEnd/ —— 混在一起就得让 vitest 往 root 外面看，容易出怪事。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'HeadEnd/**/*.test.{ts,tsx}',
      'BackEnd/**/*.test.ts',
      'shared/**/*.test.ts',
    ],
  },
})
