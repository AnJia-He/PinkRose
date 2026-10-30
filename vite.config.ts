/// <reference types="vitest/config" />
// ★ 2026-10-04：从 `vitest/config` 换成 `vite` + 上面那条三斜线引用。
//   原因：`vitest/config` 的 `defineConfig` 是按 **vitest 自己那份 vite**（npm 嵌套
//   在 node_modules/vitest/node_modules/vite，版本和根目录这份不一样）的类型签的，
//   而 `@vitejs/plugin-react` 是按根目录那份 —— 两份 Plugin 类型对不上，
//   `tsc -p tsconfig.node.json` 会报一长串"参数类型不兼容"。换成 `vite` 的
//   `defineConfig` + `vitest` 的类型引用之后，两边都落在根目录这一份上，
//   这个文件才第一次真的被类型检查管到（以前它谁也不管）。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // 业务主包当前约 0.96 MB；依赖已经拆出，单块阈值放到 1 MB 只用于
    // 反映 Apple / PWA 首包预算，不再把已经被拆小的 vendor 块当失败。
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        /**
         * 苹果端主屏应用会反复启动；把稳定依赖单独分块，版本不变时可直接命中
         * HTTP / Service Worker 缓存，也避免一张照片编辑器的业务代码更新就
         * 连带让 React、UI 原语和图标重新下载。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/react/') || id.includes('/react-dom/')
            || id.includes('/scheduler/') || id.includes('/@base-ui-components/')) {
            return 'react-vendor'
          }
          if (id.includes('/lucide-react/')) return 'icons-vendor'
          if (id.includes('/piexifjs/')) return 'exif-vendor'
        },
      },
    },
  },
  server: {
    // 开发时前端在 5173、后端在 8787。走同源代理，省掉 CORS。
    // 用 127.0.0.1 而不是 localhost：后者在 Windows 上可能先解析成 IPv6 的 ::1，
    // 而后端绑的是 IPv4，会连不上。
    proxy: { '/api': 'http://127.0.0.1:8787' },
    // 让手机能连上来试（同一个 wifi 下用电脑的局域网地址打开）。
    //
    // ⚠️ 这里原来写着「后端只听本机，所以放行 5173 这个口不会把"花真钱"的那条路
    //    暴露出去」—— **那句话是假的**。2026-10-02 的安全审计实测推翻了它：
    //    下面那条 `/api` 代理就是**把后端的每一条路由原样转发出去** ——
    //    同一个 wifi 下的人经 5173 就能注册账号、调用三个付费接口。
    //    （`scripts/手机调试-开防火墙.cmd` 里那句 "nothing that costs money is
    //    exposed" 同错。手机调试本身是有意开着的，但它暴露的是**全部 API**；
    //    配额和限速是另一件事，见 spec §11 的上线前清单。）
    host: true,
    fs: {
      // 后端代码就在这个根目录下面（server/），而 dev 服务器默认会把 root 下任何
      // 文件按 URL 发出去 —— 不挡的话浏览器能直接读到后端源码。里面没有密钥
      // （.env 在下面这份默认名单里），但不该让它露出来。
      // 前四项是 vite 原本的默认值，写出来是因为设了 deny 会覆盖掉默认值。
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/**',
        // ★ 2026-10-02 补的，**这是这份名单第一次漏掉"数据"这一类**。
        //   上面那些守的是"别把源码露出去"，而 `data/` 装的是**每个用户的照片
        //   和整个数据库**（用户名、邮箱、密码哈希）—— 偏偏 dev 是 `host: true`。
        //   实测（补之前，就是这么打下来的）：
        //     · `curl http://127.0.0.1:5173/data/ruixing.db`
        //       → 200、385 KB、文件头 `SQLite format 3`
        //     · `curl .../data/photos/<名字>.jpg` → 200、121 KB
        //   对照：同一时刻 `/.env` 是 403 —— 说明不是"vite 不管"，是**名单漏了**。
        //   两跳就能拿走全库：先下库拿到文件名名单，再照着一个个取照片。
        '**/data/**',
        '**/*.db',
      ],
    },
  },
  preview: {
    // 「在真手机上量一次」要跑**生产版本**，不能跑 dev。dev 把代码拆成几百个
    // 模块一个个传给手机 —— 那是开发服务器的副作用，真实用户不会遇到。
    // 拿 dev 的数字去对「30 秒发朋友圈」那条线，量的是个不存在的东西。
    //
    // 端口故意和 dev 用同一个 5173：手机防火墙那条规则只开了这个口（见桌面的
    // 「RuiXing 手机调试-开」），而且两个不会同时跑。
    host: true,
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    globals: true,
    environment: 'node',
    // 前端组件装了 Base UI 之后，它每次状态更新都在问"这是不是 act 环境"，
    // 不设就是每个零件刷一屏警告（见 src/test-setup.ts）。
    setupFiles: ['src/test-setup.ts'],
    // ★ 2026-10-19：8 / 4 / 2 / 1 路 worker 都实测出现过
    //   "Worker exited unexpectedly"（随后整片
    //   "Object.defineProperty called on non-object" 的假红）。★ 2026-10-21：
    //   单个 Vitest 进程连续跑完重型 App 文件后也会退化；全量入口现在由
    //   `scripts/test-all.mjs` 把重型 App 文件各自隔离、其余前端文件小批运行。
    //   每个子进程内部仍保持单进程顺序，避免并行 worker 的已知不稳定。
    fileParallelism: false,
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    // 三条线各自的测试都在这儿：前端 src/、后端 server/、共用 shared/
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
  },
})
