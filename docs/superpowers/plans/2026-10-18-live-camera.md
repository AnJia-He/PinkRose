# 实时相机拍摄实现计划 —— 2026-10-18

1. `src/ui/CameraCapture.tsx`：`getUserMedia` 实时取景、设备枚举 / 切换、前 / 后、镜像、网格、倒计时、补光（相机支持时）、快门取样、权限 / 设备错误。
2. `src/ui/Uploader.tsx`：上传前新增「实时相机」入口，拍到的 File 走现有 `onPick`，带着用户已输入的话。
3. `src/styles.css`：桌面弹层与手机全屏取景；安全区、390px 不横向溢出。
4. 单测：打开即请求相机、快门产出 JPEG、关闭停 track、权限拒绝提示；Uploader 入口开关。
5. Chromium 假相机端到端：实时预览 → 快门 → 进入编辑器。
6. WebKit 探针：入口可开、失败有提示、390px 不溢出；README / 文案规范 / 设计文档同步。
