# 作品公开分享链接实现计划 —— 2026-10-19

1. `server/db.ts`：`works.share_token` + 唯一索引（迁移 13/14）。
2. `server/works.ts`：开启 / 取回 / 停止分享、公开元数据、公开图片。
3. `server/app.ts`：公开 `/api/share/*`、作品分享开关、`/s/` 静态兜底。
4. `shared/works.ts` / `src/api/works.ts`：`SharedWork` 和客户端函数。
5. `WorkDetailPage`：生成 / 复制 / 系统分享 / 停止。
6. `SharedWorkPage` + `View` `/s/:token`：免登录只读页。
7. 测试、类型检查、构建、WebKit 全链路验收。
