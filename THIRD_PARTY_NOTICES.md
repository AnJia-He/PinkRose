# 第三方代码：来源与许可

这个仓库里有一处**不是我们写的代码** —— 从 [Compositor](https://github.com/robbietilton/Compositor)
移植的一个算法。MIT 协议要求"版权声明和许可原文跟着代码走"，两样都放在这里。

（其余的npm 依赖（Base UI / lucide / React…）各自的许可在 `node_modules/` 里，
不用在这儿重复。）

## Compositor · 修补笔引擎（MIT）

- **出处**：<https://github.com/robbietilton/Compositor>（作者 Robbie Tilton / Wonder Assembly LLC）
- **用在哪**：`src/image/heal.ts` —— 移植自该仓库的
  `Compositor/Rendering/HealPixels.c`，是点修「擦掉这里」的修补笔引擎
  （算法与行为约定照原版，见那个文件头的注释）。
- **移植时被否决的一条**：同一个仓库的 `ContentFill.c`（PatchMatch 内容感知填充）
  也移植过一轮，真照片探针把它否决了（420² 以上出硬拼接缝、还会把远处内容
  搬错位置），**代码已删** —— 这个仓库里没有它。否决的账在
  `docs/superpowers/specs/2026-10-06-edit-tools-design.md` §3.2 与
  `src/image/erase.ts` 的文件头。
- **许可**：MIT，© 2026 Wonder Assembly LLC。原文：

```
MIT License

Copyright (c) 2026 Wonder Assembly LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MiSans · 界面中文字体（小米发布，免费商用）

- **出处**：小米发布的 MiSans（v4.009）；本仓库里的这套是从 npm 包
  [`misans`](https://www.npmjs.com/package/misans)（作者 dsrkafuu）取的
  **官方切片版**（按小米官方的 `unicode-range` 切成 56 片 woff2，可变字体）。
- **用在哪**：`src/assets/fonts/misans/` —— 全站的正文与按钮（`styles.css` 的
  `--font`、`landing.css` 的 `.lp`）。2026-10-07 之前全站没有自带字体，
  访客看到的中文字取决于他电脑装了什么（没装思源的 Windows 掉微软雅黑、
  字重还会被合成），这条是那次评审的一等修复。
- **许可**：小米声明 MiSans **免费商用**；npm 包的打包部分为 **Apache-2.0**。
  许可原文副本随字体文件放在 `src/assets/fonts/misans/LICENSE.txt`。
  改字体品牌名/再分发前先看原文。
