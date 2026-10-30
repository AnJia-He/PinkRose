# 去雾（设计）— 2026-10-17

## 0. 一句话

调色面板「效果」组补上主流修图产品都有的**去雾**：一根 -100~100 的滑杆，
正数拉开雾天 / 远山前那层灰白空气，负数反过来给画面加雾。全程本地
fragment shader 计算，0 = 逐字节不动。

## 1. 为什么是去雾

Lightroom、Snapseed、VSCO、醒图、美图秀秀的调色面板里，「去雾 / Haze」
是风景和旅拍最常用的收尾项之一。它和已有的清晰度、对比度不是同一件事：

- 清晰度管中频局部反差；
- 对比度管整幅画面的黑白距离；
- 去雾先估计「远处那层发白的空气」，再只把低反差亮区拉回来。

单根滑杆、无需新纹理、无需模型，适合放进现有的单 pass 管线。

## 2. 参数契约

- 字段 `dehaze`，范围 **[-100, 100]**，中立点 0。
- 放在「效果」组第四根：`[clarity, vignette, skinSmooth, dehaze]`。
- `PARAM_KEYS` 在 `skinSmooth` 之后插入 `dehaze`；老参数的相对顺序不动。
- 总参数从 57 变成 58，uniform 从 59 变成 60（58 参数 + HSL / 曲线总开关）。
- `ZERO` / `clampAdjustments` / `toUnit` 逐字段写死，缺键老数据落 0。

## 3. 着色器

### 3.1 位置

```
清晰度 → 磨皮 → 降噪 → 锐化 → 径向虚化 → 色温 → 色彩平衡
→ 曝光 → 高光/阴影 → 对比度 → 去雾 → 饱和度 → 自然饱和度
→ HSL → 曲线 → 美颜 → 分离色调 → 暗角 → 颗粒 → LUT
```

去雾放在对比度之后、饱和度之前：先把灰白空气拉开，再让饱和度作用在
已经恢复的色阶上。LUT 仍是最后一步。

### 3.2 算法

1. 从**原始纹理**取中心和四邻域，逐个通道取最小值，得到局部暗通道；
2. 暗通道越亮 = 越像雾 / 空气层，`haze = smoothstep(0.30, 0.85, dark)`；
3. 正值：`trans = 1 - uDehaze * 0.45 * haze`，
   `c = (c - 0.05 * uDehaze * haze) / max(trans, 0.35)`，
   再按 `1 + uDehaze * 0.22 * haze` 补一点饱和度；
4. 负值：`c = mix(c, vec3(0.82, 0.86, 0.92), -uDehaze * 0.35)`，
   加一层冷色空气；
5. `abs(uDehaze) <= 1e-5` 时整段跳过，和没有这一步逐字节一致。

暗通道从 `base`（原始纹理）取，不从已经调过对比度的 `c` 取，避免
对比度滑杆改变去雾的估计。

## 4. 产品接线

- 面板由 `PARAM_GROUPS` 自动生成「效果」组第四根，标签「去雾」。
- 内置预设新增「通透风景」：去雾 34 + 清晰度 10 + 自然饱和度 12，
  让功能在预设栏里看得见。
- 对话路由：说「雾蒙蒙」「灰蒙蒙」「远处发白」给 `dehaze` 正增量；
  「加一点雾 / 柔一点」给负值，走本地 `params`，不走生成。
- 作品详情页、会话、我的预设、导入导出都跟 `PARAM_KEYS` 自动生效。
- 小程序只同步共享引擎镜像（shader / uniforms / adjustments / presets），
  不改小程序界面。

## 5. 验证

- `shared/adjustments.test.ts`：58 键、顺序、范围、clamp、toUnit。
- `src/render/uniforms.test.ts`：60 个 uniform，`uDehaze` 映射。
- `src/render/shader.test.ts`：去雾在对比度之后、饱和度之前，0 时跳过。
- `server/prompt.test.ts`：22 个提示词参数，去雾规则。
- `src/ui/AdjustmentPanel.behavior.test.tsx`：效果组四根，去雾 -100~100。
- `npm run check:lut`（真 Chrome + 真 GPU）、`npm run check:layout`、
  `npm run check:copy`、全量测试、typecheck、build。

## 6. 不做

- 不做 AI 去雾 / 天空替换；
- 不动小程序界面。
