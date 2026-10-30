# 磨皮（两条路一起上）设计 —— 2026-10-17

## 0. 背景与结论

用户要"磨皮"。经过方案评审（2026-10-17，聊天记录），拍板**方案一 + 方案二一起做**：

- **方案一（滑杆）**：`磨皮` 成为第 16 个调色参数（0~100），在显卡上实时算。
  聊天里说"磨皮一点"直接推这根滑杆；可存预设、进作品详情、随时拖回，小程序天然兼容。
- **方案二（画笔）**：工具行多一颗「磨皮」，像点修那样涂哪儿磨哪儿，交出一张新底图、
  记一笔账。给"只想磨脸、不磨衣服"这类精准需求。

不做的：AI 生成那条路不接磨皮（花钱、十几秒、长边压到 2048、有重画脸的风险 ——
见 `server/prompt.ts` 顶部 58.6% / 2.6% 那组实测）。去痘这类结构修复以后再说。

## 1. 方案一：`skinSmooth` 参数

### 1.1 参数契约

- 字段 `skinSmooth`，范围 **[0, 100]**，中立点 0（和 `splitAmount` 同款：0 在量程左端）。
- `PARAM_KEYS` / `PARAM_GROUPS` 都**追加在末尾**：效果组 = [清晰度, 暗角, 磨皮]。
  追加而不是插队 —— 老用户对"效果组前两根"的肌肉记忆不动。
- `ZERO` 补 0、`clampAdjustments` / `toUnit` 逐条写死（照项目规矩，不循环）。
- 旧数据（库里只有 15 个键的 params / 预设 / 作品）落在这条上：缺键当 0，
  和老参数加进来时的兼容策略完全一样（`clampTo` 的 `Number.isFinite` 那条）。

### 1.2 着色器（`src/render/shader.ts`，与小程序共享）

单帧完成，不引入第二通道、不依赖 mipmap —— 这样 `shader.ts` 原样同步给小程序时，
**小程序不用改一行**就能正确显示带磨皮参数的作品（它没有滑杆，值来自同步过来的
预设/会话，默认 0 = 恒等）。

算法（新增第 0.5 步，插在清晰度之后、色温之前）：

1. **肤色识别**：在 YCbCr 近似空间做软阈值 —— Cb ∈ [0.28, 0.54]、Cr ∈ [0.50, 0.72]、
   亮度 > 0.14，三段 smoothstep 相乘得到 0~1 的肤色权重 `skinWeight`。
   亮度下限不是随手写的：棕发的 Cb/Cr 和肤色几乎重叠，只有亮度能把暗发从"脸"里分开；
   深肤色落在 0.14~0.28 的过渡带里，拿到部分权重而不是被一刀切掉。
2. **保边平滑**：两圈 12 个采样点（半径随图片短边缩放：短边 × 0.003，夹在 1~10 像素），
   按"与中心亮度差"加权；**每个采样点也过一遍 `skinWeight`**，不像皮肤的邻居只保留
   12% 的发言权，避免把发丝 / 背景的暗色平均进脸颊。毛孔这类低反差细节被平均掉。
3. **边缘保护**：取两圈采样里"与中心最大的亮度差" `maxDiff`，
   `edge = smoothstep(0.055, 0.20, maxDiff)` —— 毛孔只差几个灰阶（edge≈0），
   睫毛 / 眉毛 / 发丝 / 唇线差几十个灰阶（edge≈1）。
4. **混合**：`c = mix(c, 平滑色, uSkinSmooth × skin × 0.9 × (1 − 0.85 × edge))`。
   系数 0.9 是**故意留一成原纹理**，防"美颜相机塑料脸"；高反差边缘再减 85%，
   强度 0 时 mix 第三参恒 0，与没有这一步**逐字节相同**（和清晰度/暗角那条恒等契约同一族）。

GLSL 规矩照旧：注释只用 ASCII、采样器精度限定、`npm run check:lut` 真机探针必跑。

### 1.3 提示词（`server/prompt.ts`）

- `PromptParamKey` 加第 9 个键 `skinSmooth`，标签「磨皮」。
  （这是**给模型的那一份**，和界面那份措辞可以不同；这次两边都用「磨皮」。）
- `ROUTER_SYSTEM` 的 JSON 模板补 `"skinSmooth": 0`，并加一条规则：
  "磨皮 / 皮肤修一下 → 走 params，给 skinSmooth 正增量（15~50 常见）；
  「少磨一点」给负值；它是本地效果，不要走 generate。"
- `server/validate.ts` 的 `normalizeDeltas` / `hasDroppedParams` 走 `PARAM_KEYS`，
  自动认得这个键；负数增量由 `clampAdjustments` 钳回 [0,100]（不会出现负磨皮）。

### 1.4 预设 / 界面

- 内置预设加一套「柔光人像」（`portrait`）：人像方向的起点（轻微提亮 + 降反差 +
  skinSmooth 55），让功能在预设栏里看得见。
- 调色面板效果组自动多一根「磨皮」滑杆（面板完全由 `PARAM_GROUPS` 数据驱动）。
- 作品详情页「这张图怎么来的」表自动列出（走 `PARAM_KEYS` + `isChanged`）。
- 文案：界面名「磨皮」；`docs/文案规范.md` 总表补一行，防止以后叫漂。

## 2. 方案二：磨皮画笔

### 2.1 工具形态

- `ToolId` 加 `'smooth'`，工具行多一格「磨皮」（图标 `Feather`，尺寸/线宽照
  工具行既有口径，`aria-hidden`）。
- 第二行控件（`ui/SmoothControls`）：画笔 / 橡皮（复用）、笔刷粗细、**强度**滑杆
  （0~100，默认 60）、取消 / 「磨这里」。
- 涂抹层**直接复用** `ui/RetouchOverlay`（掩码协议同一个：0~255 覆盖率）；现场类型
  复用 `RetouchScene`，`Canvas` 不多加一个 prop。
- 提交走 `app/baseEdit.ts` 的共享骨架：`beginBaseEdit` → 像素活儿 →
  `discardStaleBaseEdit` → `applyBaseEdit`。和裁剪/点修一字不差的三条：
  **不推快照、不进转盘、不写对话**；账本记在「当前这一版」的 `past` 里，
  用调色屏左下角「上一步」退。磨皮**不动参数/滤镜**（只换底图）。

### 2.2 CPU 引擎（`src/image/smooth.ts`）

**引导滤波（guided filter，自引导）**，只在掩码外接框 + 边距的工作盒里算：

1. 亮度引导：工作盒内算 L、L²、R、G、B 的**滑动窗口盒均值**（可分离两趟，O(N)）。
2. 方差 → 系数：`var = mean(L²) − mean(L)²`；`a = var / (var + EPS)`，
   `b_c = mean_c − a·mean(L)`；`smooth_c = a·L + b_c`（线性模型两端都用导向亮度 L）。
   ⚠️ 回写时不能把 `a·L` 换成 `a·orig_c`：亮度与通道均值不一致时会整体提亮 / 偏色。
   `EPS` 取 (18/255)² 量级 —— 低反差区域（皮肤）被抹平，高反差（五官边缘）保留。
3. 混合：`out = orig + (smooth − orig) × (coverage/255) × (strength/100)`。
   **coverage 为 0 的像素一个字节都不写**（和 `spotHeal` 同一契约）。
4. 半径随短边缩放：`clamp(round(短边 × 0.003), 3, 24)`；强度 0~100 由调用方给。

耗时随外接框面积线性涨 —— 沿点修两条数：外接框 > 120 万像素拦下（"分几次磨"），
> 15 万像素盖暗罩（和 `ERASE_VEIL_PIXELS` 同一档，避免大块时界面像死了）。

### 2.3 接线

- 新 hook `app/useSmooth.ts`（照 `useRetouch` 的模子：现场 = 掩码 ref + 笔刷参数，
  state 只留可显示的几样；`openSmooth` / `cancelSmooth` / `commitSmooth` / scene）。
- `App`：`pickTool` 增加一支；ToolBar 第二行三目加一支（**必须留在同一条三目里**，
  理由见 App 里那段"两个 && 数组永远 truthy"的旧账）；StepNav 在磨皮开着时也收起
  （和裁剪/点修同一条：模态工具开着时不许翻账本）；`busy` 加 `smoothing`；
  切屏 effect 里补 `closeSmooth`。

## 3. 测试与验收

- `image/smooth.test.ts`（纯函数，node 环境）：掩码外逐字节不变、掩码内方差下降、
  高反差边保留、strength 0 = 恒等、coverage 0 = 不动。
- `render/shader.test.ts`：加哨兵 —— 磨皮步在清晰度之后、色温之前；mix 系数来自
  `uSkinSmooth * skin`；强度 0 分支恒等。
- `shared/adjustments.test.ts` / `render/uniforms.test.ts` / `server/prompt.test.ts`：
  16 键、顺序、标签、prompt 里第 9 个键。
- `ToolBar.test.tsx`：4 格。
- `App.tools.test.tsx`：磨皮工具的接线（涂→磨这里→换底图→不进转盘→不写对话→
  账本能退；太大要拦；取消什么都不发生）。
- `npm test` + `npm run typecheck` 全绿；GLSL 动了 → `npm run check:lut`（真 Chrome +
  真 GPU）；界面动了 → `npm run check:layout`；文案 → `npm run check:copy`。
- 小程序：`node scripts/sync-mini-shared.mjs`（shader / uniforms / adjustments /
  presets 四份镜像跟着更新，`syncMiniShared.test.ts` 守卫）。

## 4. 风险与退路

- **肤色识别失手**（深肤色/浓妆/暖黄灯光）：偏保守（少磨），滑杆可补；后续可加
  "按人脸"的专门检测（本轮不做）。
- **磨过头塑料脸**：mix 上限 0.9 + 保边权重；预设里 skinSmooth 只给 55。
- **CPU 磨皮慢**：面积闸 + 暗罩；真机验收时若 > 2s 再调半径/降采样。
- **小程序显示**：着色器同步后小程序自动拥有同一效果（值来自同步数据）；小程序
  没有滑杆 UI —— 记入"以后小程序要补 UI"的清单，不影响本轮。
