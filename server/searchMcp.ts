import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { searchBing, type WebSearchResult } from './webSearch.ts'

const SearchInput = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(8).default(5),
}).strict()

const SearchOutput = z.object({
  query: z.string(),
  source: z.literal('bing'),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    domain: z.string(),
    snippet: z.string(),
  })),
})

export function createWebSearchMcpServer(
  search: (query: string, limit: number) => Promise<WebSearchResult[]> =
    (query, limit) => searchBing(query, { limit }),
): McpServer {
  const server = new McpServer({
    name: 'pinkrose-web-search-mcp-server',
    version: '1.0.0',
  })

  server.registerTool(
    'pinkrose_web_search',
    {
      title: 'PinkRose Web Search',
      description:
        'Search public web results for external facts that are not visible in the current photo or conversation. ' +
        'Returns concise title, URL, domain and snippet results. It never modifies the user account or photos.',
      inputSchema: SearchInput,
      outputSchema: SearchOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      try {
        const results = await search(query, limit)
        const output = { query, source: 'bing' as const, results }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      } catch {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: '这次没有取得可靠的联网搜索结果。不要猜测结果，继续按当前照片和对话上下文处理。',
          }],
        }
      }
    },
  )
  return server
}
