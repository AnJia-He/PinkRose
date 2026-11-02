import { describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createWebSearchMcpServer } from './searchMcp.ts'
import { McpWebSearchClient } from './searchMcpClient.ts'

const RESULT = {
  title: '相机参数',
  url: 'https://example.com/camera',
  domain: 'example.com',
  snippet: '官方参数摘要',
}

describe('内置搜索 MCP', () => {
  it('通过 MCP tools/list 和 tools/call 返回结构化结果', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createWebSearchMcpServer(async () => [RESULT])
    await server.connect(serverTransport)
    const client = new Client({ name: 'search-test', version: '1.0.0' })
    await client.connect(clientTransport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('pinkrose_web_search')
    const called = await client.callTool({
      name: 'pinkrose_web_search',
      arguments: { query: '相机参数', limit: 3 },
    })
    expect(called.isError).not.toBe(true)
    expect(called.structuredContent).toEqual({
      query: '相机参数',
      source: 'bing',
      results: [RESULT],
    })
    await client.close()
  })

  it('搜索异常是工具错误，不给模型伪造结果', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createWebSearchMcpServer(async () => { throw new Error('blocked') })
    await server.connect(serverTransport)
    const client = new Client({ name: 'search-test-error', version: '1.0.0' })
    await client.connect(clientTransport)

    const called = await client.callTool({
      name: 'pinkrose_web_search',
      arguments: { query: '未知问题', limit: 3 },
    })
    expect(called.isError).toBe(true)
    expect(called.structuredContent).toBeUndefined()
    await client.close()
  })

  it('宿主客户端走 MCP 调用并校验结构化结果', async () => {
    const host = new McpWebSearchClient(async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = createWebSearchMcpServer(async () => [RESULT])
      await server.connect(serverTransport)
      return clientTransport
    })
    expect(await host.search('相机参数', 2)).toEqual([RESULT])
    await host.close()
  })
})
