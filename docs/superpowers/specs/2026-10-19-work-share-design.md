# 作品公开分享链接设计 —— 2026-10-19

## 目标

让用户把修好的作品交给别人看，而不是只能下载文件：

- 作品详情页可生成一条**只读公开链接**；
- 拿到链接的人**不需要登录**，打开 `/s/<token>` 就能看；
- 可以复制链接、走系统分享，或随时停止分享；
- 停止分享后旧链接立刻 404；
- 公开页只暴露作品名、日期和图片，不暴露配方、账号、用户 id 或硬盘文件名。

## 契约

- `works.share_token` 是 opt-in 的随机 token（24 字节 base64url，唯一索引）；
  空 = 没分享。没有 token 就没有公开入口。
- 开启分享**幂等**：已经有 token 就原样返回，避免用户点几次之后把旧链接悄悄换掉。
- 公开接口：
  - `GET /api/share/:token` → `{ token, alias, createdAt, updatedAt, hasThumb }`
  - `GET /api/share/:token/image` / `/thumb` → 图片字节，`no-store`
- 停止分享只清 token，不删作品；作品被删时 token 随行一起消失。
- 分享开关不 bump `updated_at`（它同时是图片缓存钥匙和未命名作品的日期名）。
- 前端路由 `/s/:token` 在登录墙之前渲染；`app.html` 静态兜底也要认 `/s/`。

## 验收

- `server/works.test.ts`：token 幂等、公开元数据最小化、停止后 404、越权 404。
- `server/app.test.ts`：未登录不能开分享；公开读取不需要 cookie；停止后图片也 404；
  静态 `/s/<token>` 走空壳。
- `WorkDetailPage.test.tsx`：生成 → 复制 → 停止。
- `SharedWorkPage.test.tsx`：免登录渲染；失效 token 给错误页。
- 真 WebKit：上传 → 存作品 → 生成链接 → 未登录打开并加载大图 → 停止后失效。
