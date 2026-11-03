# PinkRose 桌面版说明

## 目标

桌面版让普通用户从 GitHub Releases 下载安装包后，双击 `PinkRose` 就能使用，
不再需要安装 Node.js、打开终端或手工启动 Web 服务。Windows、macOS 和
Linux 使用同一份 React 前端与 Node 服务，账号和作品仍沿用现有 SQLite
数据结构。

## 用户可见行为

- 首次启动询问数据文件夹，推荐 `文档/PinkRose`。
- 数据目录固定包含 `pinkrose.db`、`photos/`、`luts/` 和
  `.pinkrose-data.json` 标记文件。
- 可在「个人设置 → 文件保存位置」打开当前目录，或切换到空目录 /
  另一个已有 PinkRose 数据目录。
- 迁移到空目录时先停止本地服务，再复制数据；旧目录保留，程序不会自动删除。
- 安装包不包含 `.env`、API key、账号数据库或任何用户照片。

## 本地架构

1. Electron 主进程选择一个稳定的本机端口 `127.0.0.1:47831`。
2. 主进程以 Electron 自带的 Node 运行时启动 `build-server/server.cjs`。
3. 服务端按用户目录设置 `DB_PATH`、`PHOTO_DIR`、`LUT_DIR`，继续提供原有
   `/api` 接口和 `dist` 静态页面。
4. 渲染进程通过 `pinkroseDesktop` 预加载桥读取数据目录信息；
   不暴露任意 IPC、文件系统或命令执行能力。
5. 搜索 MCP 由 `build-server/searchMcp.cjs` 作为独立 stdio 子进程启动。

## 安全边界

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 禁止 WebView、外部页面接管窗口和任意新窗口；http/https/mailto 链接交给系统浏览器。
- 只允许可信应用源使用相机、麦克风和剪贴板写入权限。
- 页面响应带 CSP、`nosniff`、`frame-ancestors 'none'` 和限制性 Permissions Policy。
- 服务端只监听回环地址；模型地址仍经过私网 / DNS 解析拦截。
- 模型密钥继续用 `SESSION_SECRET` 派生的保险箱加密；桌面版的签名密钥由
  Electron 系统安全存储保护，无法使用时退回权限 `0600` 的用户配置文件。
- 安装包不携带服务端默认模型密钥。没有配置用户模型时，本地修图仍可运行；
  调用 AI 时会提示到「个人设置 → 模型配置」接入自己的模型。

## 开发与验证

```powershell
npm ci
npm test
npm run typecheck
npm run desktop:prepare
npm run desktop:smoke
npm run desktop:pack
```

`desktop:prepare` 会运行 Web 生产构建，并用 esbuild 生成
`build-server/server.cjs` 和 `build-server/searchMcp.cjs`。

本机开发可直接运行：

```powershell
npm run desktop:run
```

## GitHub 发布

`.github/workflows/desktop-release.yml` 会在推送 `v*` 标签时分别构建：

- Windows x64：NSIS 安装包、portable 免安装包；
- macOS Intel / Apple Silicon：dmg、zip；
- Linux x64：AppImage、deb。

正式发布命令：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

未配置代码签名证书时，Windows SmartScreen 和 macOS Gatekeeper 仍可能提示
“未知开发者”。正式分发前应在仓库 Secrets 中配置 Windows 代码签名和
Apple Developer 证书；没有证书时不能把“系统无提示”写成已完成。
