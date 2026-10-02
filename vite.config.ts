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
    // 三条线各自的测试都在这儿：前端 src/、后端 server/、共用 shared/
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
  },
})
