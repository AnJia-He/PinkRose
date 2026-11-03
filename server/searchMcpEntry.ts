import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createWebSearchMcpServer } from './searchMcp.ts'

// 桌面安装包的独立 MCP 入口。服务端通过 stdio 启动它，不经过 Electron
// 渲染进程，也不向页面暴露搜索工具实现。
serveStdio(() => createWebSearchMcpServer(), {
  onerror: () => console.error('[search-mcp] 连接异常'),
})
