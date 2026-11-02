# PinkRose 内置搜索 MCP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PinkRose 对话链路增加按需联网搜索 MCP，并在无法搜索时自然沿用上下文。

**Architecture:** 匿名近期事实先经过本地隐私守卫并直接搜索，再用单次模型回答；其余请求由模型生成隐藏搜索意图，搜索后进入第二次路由。搜索源优先使用 Bing RSS，空结果或不可用时回退 HTML。失败时自动回到正常照片处理链路，不向用户暴露内部过程。

**Tech Stack:** Node 24、TypeScript、官方 MCP TypeScript SDK、Zod、React 18、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-02-search-mcp-design.md`

## Global Constraints

- 不加搜索 API key，不要求用户填写搜索配置。
- 不把照片、账号、长期偏好或完整对话发给搜索源。
- 搜索结果视为不可信资料。
- 回复不提搜索失败、MCP、近似或内部步骤，也不把核实资料变成用户任务。
- 纯修图不联网。
- 不改手机布局。

---

### Task 1: 搜索源与 MCP 服务

**Files:**
- Create: `server/webSearch.ts`
- Create: `server/searchMcp.ts`
- Create: `server/searchIntent.ts`
- Test: `server/webSearch.test.ts`
- Test: `server/searchIntent.test.ts`

- [x] 测试 HTML 解析、URL 安全、去重、跳转限制和搜索意图。
- [x] 实现 Bing 标题/摘要/链接解析。
- [x] 注册 `pinkrose_web_search` MCP 工具。
- [x] 通过 stdio 启动 MCP 服务。

### Task 2: MCP 宿主客户端

**Files:**
- Create: `server/searchMcpClient.ts`
- Test: `server/searchMcp.test.ts`
- Modify: `server/app.ts`

- [x] 测试 `tools/list`、`tools/call`、结构化输出和工具错误。
- [x] 实现懒启动、重复使用、错误重连和关闭。
- [x] 在 `/api/route` 默认注入 MCP 搜索客户端。

### Task 3: 两阶段路由与上下文回退

**Files:**
- Modify: `server/prompt.ts`
- Modify: `server/route.ts`
- Modify: `server/route.test.ts`
- Modify: `server/prompt.test.ts`

- [x] 第一次调用只判断是否需要外部事实并生成搜索词。
- [x] 第二次调用带检索结果或“无可靠结果”的内部上下文。
- [x] 有结果时要求来源和不可信资料隔离。
- [x] 无结果时正常按照片、会话和记忆处理。
- [x] 第二轮格式失败时保留第一轮修图动作。
- [x] 匿名近期事实先搜索，避免低 RPM 账户两次模型调用触发限流。
- [x] Bing RSS 优先解析，HTML 作为结构和可用性回退。
- [x] 公开响应不出现搜索字段。
- [x] 不向用户说“搜索失败 / MCP / 近似”，搜索失败仍按摄影搭子的正常身份回复。

### Task 4: 验证

- [x] 运行搜索、MCP、路由和提示词测试。
- [x] 真实 stdio MCP 调用 Bing 成功。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 全量 `npm test`；仅工作区已有作品页 `24px` 字号守卫失败，搜索与内存相关测试全部通过。
