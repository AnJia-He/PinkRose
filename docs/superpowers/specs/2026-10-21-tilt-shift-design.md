# 移轴模糊设计 —— 2026-10-21

## 背景

现有「镜头」组只有以焦点为中心的径向景深虚化。建筑、街景和俯拍照片常用
移轴效果：保留一条斜向或水平的清晰带，让带外逐渐变糊，形成微缩模型感。
这项能力和径向虚化共用同一套实时渲染，不额外上传照片，也不依赖模型。

## 参数

- `lensShape`：`0–100`。`0` = 径向虚化，`100` = 移轴清晰带；面板用
  「径向 / 移轴」两个按钮切换，普通滑块不展示这个内部模式值。
- `lensAngle`：`-100–100`，shader 内映射到 `-90°–90°`；`0` = 水平清晰带。
- 继续复用 `lensBlur`（强度）、`lensRange`（清晰带宽度）、
  `lensFeather`（边缘过渡）和 `lensFocusY`（清晰带上下位置）。
- `lensFocusX` 在径向模式控制焦点左右；切到移轴时隐藏并保留原值，切回径向
  不会被拖动覆盖。

## 渲染

- 径向分支保持原算法和后向兼容；`lensShape <= 0.5` 时逐字节走旧路径。
- 移轴分支按角度建立清晰带法线，计算像素到清晰带的垂直距离；
  `lensRange` 控制半宽，`lensFeather` 控制平滑过渡。
- 带外使用相同的 20-tap 金色角圆盘模糊，强度仍由 `lensBlur` 控制。
- 画布上的辅助线只负责定位：显示旋转后的清晰带和可上下拖动的手柄，
  不进入成片像素。

## 验证

- `server/prompt.test.ts` / `server/validate.test.ts`：对话里说「移轴」「微缩模型」
  能走本地 `lensShape` / `lensAngle`，不会被误派去生成。
- `shared/adjustments.test.ts`：参数数量、顺序、范围、分组和老数据兼容。
- `src/render/uniforms.test.ts`：模式与角度进入 uniform。
- `src/render/shader.test.ts`：径向 / 移轴分支和清晰带公式。
- `src/ui/AdjustmentPanel.behavior.test.tsx`：切换模式后控件正确显示。
- `src/ui/LensFocusOverlay.test.tsx`：清晰带旋转和上下拖动。
- `src/App.adjust.test.tsx`：切回径向时原焦点左右保留。
- `npm run check:lut`：真实 Chrome + WebGL2 编译和既有渲染链。
- `npm run check:tilt-shift`：WebKit 1000px / 390px；带外纹理下降、
  带中心保持锐利、角度旋转、无横向溢出、控制台无错误。
