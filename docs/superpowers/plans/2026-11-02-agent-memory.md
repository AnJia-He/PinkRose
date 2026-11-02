# PinkRose 长期记忆实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PinkRose 增加单会话上下文记忆与可管理的跨会话稳定偏好。

**Architecture:** 服务端按登录用户读取会话历史，在路由调用中注入内部摘要、最近原文和长期偏好；超过阈值时复用同一次模型调用更新隐藏摘要。跨会话偏好存独立表，并在个人设置提供关闭和清除入口。

**Tech Stack:** Node 24、TypeScript、node:sqlite、React 18、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-02-agent-memory-design.md`

## Global Constraints

- 回复使用中文；代码、命令、字段名保持英文。
- 不改手机布局，不顺手改无关页面或流程。
- 不添加依赖，不改锁文件。
- 压缩摘要不得从公开接口、日志或界面泄露。
- 最新用户明确指令优先于摘要和长期偏好。
- 完成前运行窄范围测试、`npm run typecheck`、`npm run build`，并在桌面浏览器验证。

---

### Task 1: 数据与纯上下文规则

**Files:**
- Create: `server/memory.ts`
- Create: `server/memory.test.ts`
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Produces: `loadRouteMemory(db, userId, sessionId)`
- Produces: `saveSessionSummary(...)`, `saveProfileSummary(...)`
- Produces: `SESSION_MEMORY_TRIGGER_MESSAGES`, `SESSION_MEMORY_TRIGGER_CHARS`, `SESSION_MEMORY_RECENT_MESSAGES`

- [x] 写阈值、最近 8 条、归属隔离、级联删除的失败测试。
- [x] 追加 `session_memory` 与 `user_memory` 两条迁移和指纹。
- [x] 实现记忆读取、摘要保存、覆盖消息校验。
- [x] 运行 `npx vitest run server/memory.test.ts server/db.test.ts`。

### Task 2: 路由上下文与静默整理

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `server/prompt.ts`
- Modify: `server/route.ts`
- Modify: `server/route.test.ts`
- Modify: `server/app.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- `RouteRequest.sessionId?: number`
- `RouteDeps.memory?: { db: Db; userId: number; now?: () => number }`
- Model output may contain hidden `session_memory` and `profile_memory`; response still contains only `decision`.

- [x] 写“历史进入模型、阈值触发整理、摘要不泄露、保存失败不阻断”的失败测试。
- [x] 扩展提示词，加入固定身份、内部历史和隐藏整理任务。
- [x] 路由读取上下文、解析隐藏字段并保存。
- [x] 前端发送当前 `sessionId`。
- [x] 运行 `npx vitest run server/route.test.ts server/prompt.test.ts server/sessions.test.ts`。

### Task 3: 会话删除与摘要一致性

**Files:**
- Modify: `server/sessions.ts`
- Modify: `server/sessions.test.ts`

**Interfaces:**
- `invalidateSessionSummaryIfChanged(db, sessionId, previousMessagesJson, nextMessagesJson)`

- [x] 写“追加消息保留摘要、删除覆盖消息清摘要”的失败测试。
- [x] 在会话更新成功后执行摘要一致性检查。
- [x] 验证会话摘要不出现在 `SessionDetail`。

### Task 4: 跨会话偏好的管理接口与设置入口

**Files:**
- Create: `src/api/memory.ts`
- Create: `src/api/memory.test.ts`
- Modify: `server/memory.ts`
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`
- Modify: `src/ui/AccountPage.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- `GET /api/memory` -> `{ memory: { enabled, summary, updatedAt } }`
- `PATCH /api/memory` -> `{ memory }`
- `DELETE /api/memory` -> `{ memory }`
- Frontend calls `getMemoryProfile`, `setMemoryEnabled`, `clearMemoryProfile`.

- [x] 写接口和前端客户端的失败测试。
- [x] 实现读取、开关、清除。
- [x] 在“个人设置”增加“长期偏好”卡片，展示摘要、开关和清除按钮。
- [x] 不增加任何压缩状态或内部摘要文案。

### Task 5: 完整验证

**Files:**
- Modify only when a verified defect requires it.

- [x] 运行相关 Vitest。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 启动本地应用，在桌面宽度的浏览器检查个人设置卡片、控制台和现有对话流程。
- [x] 检查 `git diff`，确认没有覆盖无关改动。
