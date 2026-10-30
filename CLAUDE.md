# CLAUDE.md — PinkRose(对话修图)项目指南

> 这份文件是**每次开工的进门必读**。项目完整地图在 [README.md](README.md)。

## 项目定位

用聊天的方式修照片的网页产品(原名 RuiXing,产品名 PinkRose)。

- **用户不是程序员** —— 他负责"要什么",我们负责"怎么做"。汇报一律用大白话:先结论、后细节。
- 启动:`npm run dev`(同时起前后端),浏览器开 http://localhost:5173;README 里也写了可双击 `启动.cmd`。
- 前端 `5173` 热重载;**后端改动不热重载,改完必须重启**。

## 动手前先读三份项目说明(重要)

1. **[PRODUCT.md](PRODUCT.md)** —— 产品定位、核心用户、原则、架构入口和明确缺口。
2. **[README.md](README.md)** —— 权威地图:「想改什么 → 去哪找」对照表 + 每个页面/文件夹是干嘛的。
   **动手前先查它**,别瞎翻代码。
3. **[docs/文案规范.md](docs/文案规范.md)** —— **任何界面文案改动之前必读**(按钮名、导航词、落地页句子)。
   两张脸(门面 / 工具)两种语域,还有一堆"能逐条核"的硬规矩。2026-09-30 因没读它踩过坑。

## 硬红线(别碰)

- `.env` —— 钥匙。别打开看、别外传。
- `data/` —— **用户的账号和照片都在里面**,删了找不回。
- 工程配置:`package.json`、`vite.config.ts`、`tsconfig*.json`、`index.html` —— 动了可能起不来。

## 提交前必须过

- `npm test` + `npm run typecheck` —— **两个都要绿**(测试绿 ≠ 类型没病)。
- ⚠️ **动了 `src/render/` 里任何 GLSL → 必须跑 `npm run check:lut`**(真 Chrome + 真 GPU)。
  字符串哨兵 / typecheck / build / `check:layout` 四样都看不出"整个着色器程序编译不过"——
  那种坏法是**每张照片全黑**,只有这一条探针抓得到(2026-10-05 真机上抓到过一次)。

## 做视觉/界面改动时

- 色号、圆角、间距:看 `src/styles.css` **最上面一段的"色号表"**;落地页是 `LandingPage.tsx` + `landing.css`。
- 技能提示(全局技能库):改 UI 时可用 `impeccable` / `frontend-design` / `emil-design-eng`;挑毛病可用 `impeccable`。
- 技术栈:React 18 + Vite + TypeScript + **原生 CSS(没有 Tailwind,组件底座是 base-ui,不是 shadcn/radix)** —— 别按 Tailwind 思路改。
- 图表/视觉素材:照片类素材在 `create-image/`(原料),公开文件在 `public/`。
- 设计文档:`docs/superpowers/specs/`;实现计划:`docs/superpowers/plans/`。

## 其他

- 布局检查:`npm run check:layout`(移动端);文案导出检查:`npm run check:copy`。
- `scripts/smoke.mjs` **会花钱**(真实 API,只手动跑,不进 CI)。
- `archive/` 是 2026-09 的旧实验档案,别复活;`dist/`、`node_modules/` 是自动生成的,别手改。
- 产品法律文档草案在 `docs/legal/`(用户协议、隐私政策)—— 改界面涉及隐私/条款措辞时参考。
