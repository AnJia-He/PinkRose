// 把 Node 服务与联网搜索 MCP 分别打成桌面版可执行脚本。
//
// 两个入口必须留在同一目录：`searchMcpClient.ts` 在运行时会从同目录找
// `searchMcp.cjs`，这样开发时用 `.ts`、安装包里用 `.cjs`，不需要复制源码。
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const outdir = resolve('build-server')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}

await build({
  ...shared,
  entryPoints: [resolve('server/index.ts')],
  outfile: resolve(outdir, 'server.cjs'),
})

await build({
  ...shared,
  entryPoints: [resolve('server/searchMcpEntry.ts')],
  outfile: resolve(outdir, 'searchMcp.cjs'),
})

console.log('桌面服务已构建：build-server/server.cjs + build-server/searchMcp.cjs')
