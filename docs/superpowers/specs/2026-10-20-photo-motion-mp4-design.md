# 照片视频 MP4 设计 —— 2026-10-20

## 0. 为什么还要 MP4

GIF 已经覆盖轻量分享，但只有 256 色，平台兼容性也不如 MP4。浏览器端
MediaRecorder 在部分 WebKit 不可用，所以 MP4 走本机 Node 服务 + ffmpeg：
客户端只负责把照片按目标画幅合成成 JPEG 帧，服务端固定参数编码，返回 Blob。

## 1. 输入契约

- 2–12 帧；宽高 64–1920 且为偶数；每张停留 200–5000ms；
- 帧是 `data:image/jpeg;base64,...`，单帧 ≤3MB，总帧 ≤10MB；
- 客户端在本地完成 cover / contain、留白和缩放，服务端不再读原始照片。

## 2. 服务端

- `POST /api/motion`：先 `requireUser`，再读 JSON；
- `server/motion.ts` 校验后写入系统临时目录，调用：
  `ffmpeg -framerate 1000/frameMs -i frame-%03d.jpg -vf scale=w:h:flags=lanczos,format=yuv420p -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -an -movflags +faststart`
- 输出 H.264 / 30fps / faststart MP4，返回后立即删除临时目录；
- 没有 ffmpeg 返回 503 和一句可执行提示；不会把命令行输出回显给用户。

## 3. 界面

- 照片动图面板里新增「导出 MP4」，和 GIF 共用画幅、宽度、停留、填白设置；
- 文件名为 `PinkRose-motion-YYYYMMDD-HHmm.mp4`；
- MP4 失败时保留 GIF 下载，不让整页变成错误态。

## 4. 验证

- `server/motion.test.ts`：帧数 / 偶数尺寸 / 帧时长 / 格式校验；ffmpeg 参数固定；
- `ui/GifPanel.test.tsx`：MP4 参数与下载文件名；
- Chromium：真实登录 → 上传两张 → 导出 MP4，ffprobe 读到 H.264 720×720、
  30fps、1.6 秒，下载后无控制台错误；
- iPhone WebKit 390×844：同一路径导出 MP4，页面无横向溢出，下载文件名正确。
