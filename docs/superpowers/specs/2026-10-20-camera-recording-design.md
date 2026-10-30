# 相机录像 → 短片调色（2026-10-20）

## 要解决什么

实时相机此前只能拍照 / 连拍，而产品已经能剪短片、加字幕和音乐。
把两端接起来：在相机面板里录一段（最长 20 秒），录完直接送进「短片调色」。

## 关键决定

### 1. 容器优先 WebM，Safari 才用 MP4

Chromium 对 `MediaRecorder.isTypeSupported('video/mp4;codecs=h264')` 回答 true，
但实际录出来是 **VP9 装在 MP4 里**（ffprobe 确认 vp9/mp4），Chrome 自己都播不了。
所以顺序改成：

`video/webm;codecs=vp9` → `vp8` → `webm` → `video/mp4;codecs=h264` → `mp4`

Safari 不支持 WebM，会自然落到 MP4（真的 H.264）。

### 2. WebM 没有时长头

MediaRecorder 的 WebM `duration` 是 `Infinity`。探测时把 `currentTime` 顶到极大值，
让浏览器扫完整段后算出真实时长；服务端探测允许 `durationMs = 0`（未知），
并跳过「片段是否超出源片」的边界检查。

### 3. 种子文件不要在 effect 里立刻清掉

开发模式下 effect 会清理一次；如果先把预览 URL 建好，清理时 revoke 会把还在
加载的探测打断。现在先用探测函数自己的临时 URL，成功后建预览 URL，并在真正
加进列表后才通知上层「种子已用」。

### 4. 录像默认带麦克风

相机流本身是 `audio: false`。点「录像」时，如果「声音」开关是开的，会另外
申请一路麦克风，把它的音轨和现有视频轨合成一个 `MediaStream` 再交给
MediaRecorder；停止 / 关闭 / 卸载时音轨一律 `stop()`。
麦克风被拒不影响录像：提示一句「只录画面」，继续录视频。

实测：录到的文件是 VP9 + Opus，导出后是 H.264 + AAC（2.166 秒）。

## 接线

`CameraCapture.onRecorded` → `Uploader.onRecordVideo` → `App.onRecordVideo`
（设 `videoSeed` 并切到作品页）→ `GalleryPage` 打开 `VideoPanel` →
`initialFiles` 自动加入。

## 验证

- `CameraCapture.test.tsx`：假 MediaRecorder 录一段，交给 onRecorded；
- `VideoPanel.test.tsx`：带进来的文件自动入列表、种子标记只清一次；
- Chromium + 虚拟摄像头实测：录 2.3 秒 → 自动进入短片调色 →
  导出 2.333 秒 H.264 1280×720 MP4。
