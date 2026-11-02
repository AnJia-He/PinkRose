import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { WebSearchClient, WebSearchResult } from './webSearch.ts'

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

type TransportFactory = () => Promise<import('@modelcontextprotocol/client').Transport>

function stdioTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./searchMcp.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stderr: 'inherit',
  })
}

export class McpWebSearchClient implements WebSearchClient {
  private readonly transportFactory: TransportFactory
  private client: Client | null = null
  private connecting: Promise<Client> | null = null

  constructor(transportFactory: TransportFactory = async () => stdioTransport()) {
    this.transportFactory = transportFactory
  }

  private async connected(): Promise<Client> {
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({
          name: 'pinkrose-search-host',
          version: '1.0.0',
        })
        await client.connect(await this.transportFactory())
        this.client = client
        return client
      })()
    }
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async search(query: string, limit = 5): Promise<WebSearchResult[]> {
    const call = async () => {
      const client = await this.connected()
      const result = await client.callTool({
        name: 'pinkrose_web_search',
        arguments: { query, limit },
      }, { timeout: 15_000 })
      if (result.isError) throw new Error('联网搜索没有返回可靠结果')
      const parsed = SearchOutput.safeParse(result.structuredContent)
      if (!parsed.success) throw new Error('联网搜索结果格式不正确')
      return parsed.data.results
    }

    try {
      return await call()
    } catch {
      // 子进程可能被系统回收；下一次查询重新握手一次。
      await this.close()
      return call()
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = null
    this.connecting = null
    if (client) await client.close().catch(() => {})
  }
}
