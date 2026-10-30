# HDR 局部色调映射（设计）— 2026-10-18

## 0. 一句话

调色面板「效果」组补上 **HDR**：一根 0–100 的滑杆，按局部亮度把暗部提起来、
亮部压回去，再加一点局部反差。0 = 一个字节都不动，全程本地 fragment shader。

## 1. 为什么是它

逆光、窗内窗外、夜景灯牌这类大光比场景，单靠高光 / 阴影滑杆容易把整张图
拉平；Lightroom、Snapseed、醒图都有独立的 HDR / 局部对比入口。现有产品
已有清晰度、去雾、高光 / 阴影，但缺一个把「暗部细节」和「高光不过曝」
同时处理的局部色调映射。

## 2. 参数契约

- 字段 `hdr`，范围 **[0, 100]**，中立点 0；
- 放在「效果」组第五根：`[clarity, vignette, skinSmooth, dehaze, hdr]`；
- `PARAM_KEYS` 在 `dehaze` 之后插入；总参数 59，uniform 61（59 + HSL / 曲线开关）；
- 进预设 / 会话 / 作品配方 / 对话路由；0 时与没有这一步逐字节一致。

## 3. 着色器

放在镜头虚化之后、色温之前：

```
… 清晰度 → 磨皮 → 降噪 → 锐化 → 径向虚化 → HDR → 色温 …
```

算法：

1. `l = 当前像素亮度`，`local = 原始纹理 4 邻域均值亮度`；
2. 暗部：`lift = hdr * (1 - smoothstep(0, 0.45, local)) * 0.18`；
3. 亮部：`comp = hdr * smoothstep(0.55, 1.0, local) * 0.18`；
4. `c += lift * (1 - l) - comp * l`；
5. 局部反差：`c += (c - blur) * hdr * 0.35`；
6. 轻微补饱和：按亮度保色的方式乘 `1 + hdr * 0.12`；
7. `uHdr == 0` 时整段跳过。

`local` 用原始纹理的模糊，避免把已经调过的高光 / 阴影当成场景亮度。

## 4. 产品接线

- 面板「效果」组自动多一根 HDR 滑杆；
- 预设新增「HDR 风景」：HDR 45 + 高光 -26 + 阴影 24 + 清晰度 14；
- 对话路由：说「大光比」「逆光」「暗部死黑、高光过曝」给 `hdr` 正增量，
  走本地 params，不走生成；
- 作品详情、会话、我的预设、导入导出都跟 `PARAM_KEYS` 自动生效；
- 小程序只同步共享引擎镜像，不改界面。

## 5. 验证

- `shared/adjustments.test.ts`：59 键、顺序、范围、clamp、toUnit；
- `src/render/uniforms.test.ts`：61 个 uniform，`uHdr` 映射；
- `src/render/shader.test.ts`：HDR 在镜头虚化之后、色温之前，0 时跳过；
- `server/prompt.test.ts`：23 个提示词参数，HDR 规则；
- `AdjustmentPanel.behavior` / `App.sessions`：33 根滑块；
- 真机探针：暗 / 中 / 亮三条色带，HDR 后暗部变亮、亮部变暗、中间基本不动；
- `npm test`、typecheck、build、check:layout、check:copy、check:lut。

## 6. 不做

- 不做多帧 HDR 合成；
- 不做 AI 大光比修复；
- 不动小程序界面。
