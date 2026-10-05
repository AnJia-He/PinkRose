# PinkRose · 对话修图

用聊天的方式修照片的网页产品（原名 RuiXing）。

**想启动它**：双击 `启动.cmd`，浏览器打开 http://localhost:5173

> **想看 / 改项目里的东西**：双击 `打开项目.cmd` —— 用 VS Code 打开这份地图，
> 按 `Ctrl+Shift+V` 切成预览，下面所有**文件路径点一下就能打开**。
> （想直接改：打开后改完按 `Ctrl+S` 保存，浏览器里刷一下就变。）

---

## 想调整什么细节，去哪找

| 想改的东西 | 去哪 |
|---|---|
| 页面上的一句话 / 按钮名字 | `src/ui/` 里对应页面的文件（见下一个表） |
| 颜色、大小、圆角、间距 | [src/styles.css](src/styles.css) —— 最上面一段就是"色号表" |
| 产品介绍页（落地页）的一切 | [LandingPage.tsx](src/ui/LandingPage.tsx) + [landing.css](src/landing.css) |
| 页面上用的照片、字体、Logo | `src/assets/`（landing / welcome / logo / fonts） |
| AI 怎么理解人话（给模型的提示词） | [prompt.ts](server/prompt.ts) |
| 写文案的规矩（怎么说话、禁用什么词） | [文案规范.md](docs/文案规范.md) |
| 模型的接口地址、钥匙 | 界面上「个人设置 → 模型配置」；代码在 [models.ts](server/models.ts) |

### `src/ui/` 里每个页面分别是哪个文件

| 页面 | 文件 |
|---|---|
| 产品介绍（落地页） | [LandingPage.tsx](src/ui/LandingPage.tsx) |
| 登录 / 注册 | [LoginPage.tsx](src/ui/LoginPage.tsx) |
| 修图主界面（骨架） | [App.tsx](src/App.tsx) |
| 对话栏（右边那一条） | [ChatPanel.tsx](src/ui/ChatPanel.tsx) |
| 照片显示区 | [Canvas.tsx](src/ui/Canvas.tsx) |
| 上传照片（欢迎页照片球） | [WelcomeGlobe.tsx](src/ui/WelcomeGlobe.tsx) + [Uploader.tsx](src/ui/Uploader.tsx) |
| 对话列表 | [SessionsPage.tsx](src/ui/SessionsPage.tsx) |
| 调色面板（调色/微调） | [AdjustmentPanel.tsx](src/ui/AdjustmentPanel.tsx) + [ColorWheel.tsx](src/ui/ColorWheel.tsx) |
| 作品集 | [GalleryPage.tsx](src/ui/GalleryPage.tsx) |
| 作品详情 | [WorkDetailPage.tsx](src/ui/WorkDetailPage.tsx) |
| 个人设置 | [AccountPage.tsx](src/ui/AccountPage.tsx) |
| 模型设置 | [ModelSettings.tsx](src/ui/ModelSettings.tsx) |
| 左侧导航栏 | [Nav.tsx](src/ui/Nav.tsx) |

---

## 每个文件夹是干什么的

| 文件夹 | 是什么 | 要不要管 |
|---|---|---|
| `src/` | 网页界面代码 —— **想改样子主要在这** | 要 |
| `server/` | 后台（登录、AI 调用、存照片） | 一般不用 |
| `shared/` | 前后两边共用的少量定义（含几句共用文案） | 一般不用 |
| `docs/` | 设计文档、文案规范、用户协议 / 隐私政策草案 | 想看规矩时进来 |
| `create-image/` | 素材原图（做产品页、欢迎页图片的原料） | 不用 |
| `archive/` | 旧档案：2026 年 9 月的实验脚本和小程序调研 | 不用 |
| `test-photos/` | 测试工具自己用的照片 | 不用 |
| `scripts/` | 开发用的小工具 | 不用 |
| `public/` | 网站公开的小文件 | 不用 |
| `data/` | **你的账号和照片数据** | ⚠️ 千万别删 |
| `dist/` | 打包产物（自动生成，删了会重生） | 不用 |
| `node_modules/` | 下载来的依赖（自动生成） | 不用 |
| `.superpowers/` | Claude 的工作台（画板、验收截图、过程档案），隐藏目录 | 不用 |

## ⚠️ 别碰这几样

- `.env` —— 钥匙。别打开看、别发给任何人。
- `data/` —— 你的账号和照片都在里面，删了就找不回来。
- `package.json`、`vite.config.ts`、`tsconfig*.json`、`index.html` —— 工程配置，动了可能起不来。

---

## 给接手的人（或 AI 助手）

- 测试：`npm test` ／ 类型检查：`npm run typecheck` —— 提交前**两个都要绿**
  （vitest 不做类型检查，「测试全绿」不等于「类型没病」）。
- 前端 dev 在 `5173`（`npm run dev` 同时起）；**后端改动不热重载**，改完要重启。
- 设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`；
  写文案前先读 [文案规范.md](docs/文案规范.md)。
- [smoke.mjs](scripts/smoke.mjs) 会**花钱**（真实 API），只手动跑，不进 CI。
