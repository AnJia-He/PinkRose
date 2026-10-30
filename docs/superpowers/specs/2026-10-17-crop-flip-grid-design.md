# 裁剪翻转与构图网格（设计）— 2026-10-17

## 0. 一句话

裁剪工具补上水平/垂直翻转和三分构图网格。翻转会真正改变成片像素，
网格只画在预览里，不写进导出。

## 1. 翻转

- `CropSpec` 增加可选 `flipH` / `flipV`；
- `cropToBitmap` 在 `rotate` 之后、`drawImage` 之前做 `scale(±1, ±1)`，
  翻转的是底图自己的中心坐标系；
- Canvas 预览使用同一顺序的 CSS：`rotate(-angle) scale(k) scaleX/scaleY`；
- 翻转不改裁剪框、输出尺寸和调色参数；和旋转、比例档可以一起用。

## 2. 网格

- `CropScene.grid` 是纯预览状态，不进 `CropSpec` 的输出像素；
- `CropOverlay` 在裁剪框里画两竖两横（1/3、2/3），指针事件仍然是框的；
- 默认关闭；点「网格」开关。

## 3. 界面

裁剪第二行新增「水平翻转 / 垂直翻转 / 网格」。窄屏继续走横向滚动，
取消 / 完成 sticky 在右边，行高不变。

## 4. 验证

- `image/crop.test.ts`：翻转调用顺序和符号；
- `App.tools.test.tsx`：翻转交给 `cropToBitmap`，网格进预览现场；
- 真浏览器：左右异色图翻成蓝/红，网格 4 条线，完成后的像素真的镜像；
- `check:layout`：裁剪第二行仍在 390px 内、出口可达。
