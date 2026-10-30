# 一键自动（设计）— 2026-10-17

## 0. 一句话

调色面板头加一颗「自动」：本地读一张缩小底图，按直方图和灰度世界假设，
给出一组保守的曝光 / 对比度 / 高光 / 阴影 / 饱和度 / 自然饱和度 / 轻微
白平衡。它不联网、不花钱，改的是现有参数，可撤销。

## 1. 算法

`src/core/autoEnhance.ts` 的 `autoAdjustments(samples)`：

- 5% / 50% / 95% 亮度分位；
- 曝光：把中位亮度往 0.48 拉，夹到 -40~45；
- 对比度：95%−5% 的跨度小于 0.62 时加，夹到 -18~32；
- 高光：95% 接近 1 时收回；阴影：5% 接近 0 时抬起；
- 饱和度 / 自然饱和度：平均彩度低时加；近黑白图**不硬加**（避免把黑白照片染成彩色）；
- 白平衡：灰度世界，只做 ±12（色温）和 ±8（洋红—绿）的轻微回拉；
- 所有值取整并再夹进 `PARAM_RANGE`。

空样本返回全 0 —— 没有可靠数据就不猜。

## 2. 覆盖范围

只覆盖这八项：

```
temperature / exposure / contrast / highlights / shadows /
saturation / vibrance / cbMagentaGreen
```

清晰度、暗角、HSL、曲线、美颜、几何、镜头虚化等**原样保留** —— 自动不该把
用户自己做的创作选择重置成"平均照片"。

## 3. 接线

- `App.tsx` 的 `autoEnhance` 采 `image.bitmap`（底图，不含参数 / Lut），
  调 `autoAdjustments`，再 `setParams(p => ({ ...p, ...auto }))`；
- 改参数走和滑块同一条账本 / 落盘路，不推快照、不写对话、不花钱；
- 面板头新增「自动」按钮，`onAuto` 由 App 提供；采样失败时给一句人话。

## 4. 不做什么

- 不做 AI 识别场景 / 人脸；
- 不做自动构图 / 自动裁剪；
- 不自动清 Lut、不自动改创作参数；
- 不动小程序界面。

## 5. 验证

- `src/core/autoEnhance.test.ts`：暗图 / 亮图 / 低反差 / 偏色 / 黑白 / 空样本 / 范围；
- `AdjustmentPanel.behavior.test.tsx`：按钮把动作交给上层；
- `App.adjust.test.tsx`：暗底图点自动 → 曝光提高、对比度提高、饱和不硬加、
  不调用生成；
- `npm test` / `typecheck` / `check:layout` / `check:copy`。
