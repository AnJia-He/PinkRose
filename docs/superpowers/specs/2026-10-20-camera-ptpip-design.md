# 相机无线 PTP/IP 接入设计 —— 2026-10-20

## 目标

在已有的 USB gphoto2 控制上加无线入口：相机支持 PTP/IP 时，不需要厂商 SDK
或 USB 线，网页仍使用同一套实时取景、快门、参数和拍摄预设。

## 用法

让相机进入 PC Remote / PTP 模式，并与运行相机桥的电脑连同一个 Wi-Fi：

```bash
npm run camera:bridge -- --gphoto2 --gphoto2-ip 192.168.1.50
```

默认转换成 `ptpip:192.168.1.50`（PTP/IP 默认端口 15740）。
特殊端口 / 自定义 port 字符串：

```bash
npm run camera:bridge -- --gphoto2 --gphoto2-port ptpip:192.168.1.50:15740
```

也支持环境变量 `GPHOTO2_IP` / `GPHOTO2_PORT`。
只要出现 `--gphoto2-ip` / `--gphoto2-port` / `--gphoto2-command`，就会自动启用
gphoto2，不必再额外记 `--gphoto2`。

网页里也可以运行时配置：先启动不带相机 provider 的桥，再打开「相机桥」，在
「无线相机」里填写相机 IP 和可选端口。桥会通过
`PUT /api/camera/provider` 把当前 provider 切成 gphoto2 PTP/IP；网页测试和
iPad / iPhone 使用同一条接口。

配置会写进相机目录的隐藏文件 `.pinkrose-camera.json`，只包含 IP 和可选端口。
桥下次以 `--dir` 启动、且没有显式指定 provider 时会自动恢复这份配置；
文件损坏或字段非法时直接忽略，不影响文件夹桥。断开无线相机会删除该文件。

这个接口只在桥启动时注入了 `configureControl` 才开放；自定义厂商适配器或
mock provider 的桥不会出现输入框。请求必须带
`x-pinkrose-camera: 1`，IP 不能包含协议、斜杠或空白，端口必须是 1~65535。

## 探针

不开网页、不启动桥服务，直接确认相机与适配器：

```bash
npm run camera:probe -- --gphoto2-ip 192.168.1.50
npm run camera:probe -- --provider ./my-adapter.mjs
npm run camera:probe -- --mock-live test-photos/e2e_portrait.jpg
```

探针打印目标 provider、连接状态、机型、取景 / 快门 / 参数能力和完整 schema；
连接失败时退出码非 0，并提示检查 PC Remote、IP、防火墙和 gphoto2 是否安装。

## 实现

- `Gphoto2ProviderOptions.port` 存端口字符串；
- provider 内每条 gphoto2 命令都在最前面加 `--port <port>`；
- `cameraProvider` 把 spec 的 `port` 继续传给 gphoto2 构造器；
- CLI 把 `--gphoto2-ip` 拼成 `ptpip:<IP>`，`--gphoto2-port` 则原样使用；
- 网页把 IP / 数字端口交给运行中的桥，桥再调用同一个 `loadCameraProvider`
  构造 gphoto2 provider；
- 运行时配置原子写入 `.pinkrose-camera.json`，CLI 启动时在无显式 provider 的
  情况下恢复它；
- 启动日志明确打印当前 port，连不上时提示检查 PC Remote、防火墙和机型支持。

## 边界

- 不是所有 Canon / Sony / Nikon / Fujifilm 机型都开放 PTP/IP；不支持时仍需
  USB 或厂商适配器。
- 本机当前没有安装 gphoto2，因此只能用假执行器验证参数构造；真实相机仍需
  在硬件上验收。
- 不自己实现 PTP/IP 协议，避免在没有硬件的情况下写一套无法验证的网络栈。

## 验证

- `server/gphoto2.test.ts`：带 port 时第一条命令是
  `--port ptpip:... --auto-detect`。
- `server/cameraProvider.test.ts`：spec 的 port 原样交给 gphoto2 构造器。
- `server/cameraBridge.test.ts`：运行时配置的鉴权、IP 校验、provider 切换与状态刷新。
- `src/ui/CameraBridge.test.tsx`：网页输入 IP、提交控制标记、显示连接结果。
