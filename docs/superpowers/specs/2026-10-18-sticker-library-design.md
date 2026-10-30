# 贴纸库扩展设计 —— 2026-10-18

## 目标

把内置贴纸从 5 种扩到 12 种：星 / 心 / 闪光 / 箭头 / 对话框 /
花 / 云 / 皇冠 / 音符 / 闪电 / 对勾 / 太阳。仍然只改当前这一版底图，
可拖位置、调大小、旋转和颜色，应用后可撤销。

## 实现

- `src/image/sticker.ts`：`StickerShape` 扩容、SVG path 扩容、白名单扩容。
- `src/ui/StickerControls.tsx`：形状胶囊扩容。
- 预览（`StickerOverlay`）和成片（`Path2D`）继续共用同一份 path。
- 新形状都是单 path 填充，不引入外部素材、不改小程序。

## 验收

- `image/sticker.test.ts`：12 种形状都有非空 path，未知形状仍回星。
- 真浏览器（Chromium + WebKit）：形状列表 12 颗、选花 / 太阳能预览并写进底图，
  390px 第二行可横滑且页面不横向溢出。
