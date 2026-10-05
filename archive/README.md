# archive · 旧档案

不参与构建、平时不用看，但**结论的证据在这里**（设计文档和记忆都指向它），所以留着。

## spike/ —— 2026-09-21 ~ 09-23 的第一轮调研

- `evidence/` —— 实验证据图。⚠️ **`scripts/smoke.mjs` 拿其中两张当底图**
  （`real_1027.jpg` / `input_scene.jpg`），别删、别改名，动了 smoke 脚本会跑不起来。
- `probe_*.py` —— 7 个 Python 探针，当时直接打真实 API 量边界（尺寸约束、人脸保真度、
  路由稳定性……），结论后来都进了 `docs/superpowers/specs/`。
- `miniprogram-webgl/` —— 小程序侧的 webgl 可行性调研（含它自己的 README）。

★ 2026-10-05 从根目录 `spike/` 收编进来（用户：「这个项目目录好乱」）。
文件本身一个没动；`scripts/smoke.mjs` 和 `.gitignore` 里的路径同步改过。
