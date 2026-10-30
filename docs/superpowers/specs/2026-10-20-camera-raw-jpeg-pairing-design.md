# 相机桥 RAW+JPEG 配对设计 —— 2026-10-20

## 0. 背景

很多相机在 RAW+JPEG 模式下会同时写：

```
IMG_0001.CR3
IMG_0001.JPG
```

相机桥原来按文件逐条列出，网页会看到两张；「自动导入 / 导入全部」会把同一张
照片导两次。对相机用户来说，这是一眼能看出的重复。

## 1. 列表规则

- 同一目录下、同 stem（去掉扩展名，大小写不敏感）的 RAW + JPG 合并成一组；
- 组的主条目用 JPEG（网页可直接预览），RAW 作为 `raw` 元数据挂在主条目上；
- 只有 RAW 时保持原样，仍按转换器 / 原图两条路导入；
- 分组后再按主条目 mtime 倒序，`maxPhotos` 数的是组，不是文件。

支持的 RAW 后缀与桥现有的 DNG / CR2 / CR3 / NEF / ARW / RAF / ORF / RW2 一致。

## 2. 接口

- `/api/camera/photos` 的每条照片新增可选 `raw`：
  `{ id, name, size, mtime, type, url, convertUrl }`；
- 主条目的 `url` 是 JPEG，RAW 的 `url` 是同名原片；
- 有转换器时 RAW 仍有自己的 `convertUrl`，没有则为 null。

## 3. 界面

- 列表显示一个条目和「JPG + RAW」标记；
- 「导入」取 JPEG；
- 额外「RAW」按钮取原始文件；浏览器能否直接解码取决于格式和浏览器；
- 自动导入按主条目 id 去重，因此 JPG/RAW 先后落盘只触发一次。

## 4. 验证

- `server/cameraBridge.test.ts`：同名文件只列一条、raw 元数据与 URL 正确；
- `ui/CameraBridge.test.tsx`：只渲染一条，默认导入 JPG，点 RAW 取 CR3；
- 全部相机桥测试通过，类型检查通过。
