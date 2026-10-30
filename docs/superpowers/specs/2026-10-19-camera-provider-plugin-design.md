# 相机厂商适配器插件设计 —— 2026-10-19

## 1. 现状与缺口

相机桥已经覆盖四条真实工作流：

- **文件夹桥**：EOS Utility / Imaging Edge / Camera Control Pro / Capture One
  把照片落到一个目录，网页轮询导入；
- **gphoto2**：USB PTP 机型的实时取景、快门、ISO / 光圈 / 快门速度等参数。
- **Canon CCAPI**：支持无线 Camera Control API 的 Canon 机型，直接通过相机 HTTP
  接口读取状态 / 参数、启动实时取景、按快门并下载新照片，也能从当前存储目录
  导入最近照片而无需先按快门。
- **Sony Camera Remote**：通过 `/sony/camera` JSON-RPC 进入遥控模式，解析相机
  二进制实时取景流，读取可选参数、按快门并下载相机返回的照片；支持内容传输
  的机型还能切到 `Contents Transfer` 后按日期导入最近照片。

缺的是厂商私有 SDK（Canon EDSDK、Nikon SDK、Sony Camera Remote SDK、
Fujifilm 等）的**正式接入点**。之前只能在 `scripts/camera-bridge.ts` 里改代码，
每接一个厂商都动主程序。

## 2. 接口

适配器模块导出以下任意一种：

```js
// my-adapter.mjs
export function createCameraProvider({ root }) {
  return {
    // 必需：连接状态 + 网页要渲染的能力 / 参数描述
    status: async () => ({
      connected: true,
      model: 'Canon EOS R5',
      capabilities: { liveView: true, shutter: true, settings: true },
      settingsSchema: [
        { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 25600, step: 100 },
        {
          key: 'shutter', label: '快门', type: 'select',
          options: [{ value: '1/125', label: '1/125' }],
        },
      ],
    }),

    // 可选：实时取景一帧（JPEG / PNG 字节）
    liveView: async () => new Uint8Array(),

    // 可选：按快门；返回 saved 时网页会自动导入这张
    capture: async () => ({ saved: 'IMG_0001.JPG' }),

    // 可选：读 / 写相机参数
    getSettings: async () => ({ iso: 400 }),
    setSettings: async patch => ({ iso: patch.iso ?? 400 }),
  }
}
```

也接受 `createProvider`、默认导出函数，或直接默认导出一个带 `status()` 的对象
（CommonJS 的 `module.exports = { ... }` 同样可用）。

## 3. 启动

```bash
npm run camera:bridge -- --provider ./my-adapter.mjs
# 跨设备（iPad / iPhone 同一 Wi-Fi）
npm run camera:bridge -- --provider ./my-adapter.mjs --host 0.0.0.0
```

也可以设 `CAMERA_BRIDGE_PROVIDER_MODULE=./my-adapter.mjs`。

优先级：

1. `--provider` / `CAMERA_BRIDGE_PROVIDER_MODULE`
2. `--mock-live <jpg>`（开发演示）
3. `--canon-ccapi <IP 或 URL>` / `CANON_CCAPI_URL`
4. `--sony-camera <IP 或 URL>` / `SONY_CAMERA_URL`
5. `--gphoto2`
6. 不接可控相机（只做文件夹桥）

Canon 无线相机示例：

```bash
npm run camera:bridge -- --canon-ccapi 192.168.1.50
npm run camera:probe -- --canon-ccapi 192.168.1.50
```

相机需先在「无线通信设置 → Wi-Fi 设置」启用 Camera Control API。适配器默认
使用 8080 端口，也可传完整 `http://相机IP:端口`。

Sony 示例：

```bash
npm run camera:bridge -- --sony-camera 192.168.1.70
npm run camera:probe -- --sony-camera 192.168.1.70
```

相机需打开 Wi-Fi「遥控拍摄」/ Smart Remote Control。适配器默认使用 10000
端口；相机可能要求电脑加入相机自己创建的 Wi-Fi。

相机桥正常启动后，网页的「无线相机 → 连接方式」可以直接选择 gphoto2、
Canon CCAPI 或 Sony Camera Remote。地址会经过与命令行相同的协议、凭据和端口校验后热切换，
并写进相机目录的隐藏运行时配置；桥重启会自动恢复上次选择，网页端只在本机
记住最近输入。

## 4. 加载与校验

`server/cameraProvider.ts` 负责：

- 解析相对 / 绝对路径，文件不存在直接给出路径；
- 动态 `import()` 模块；
- 找 `createCameraProvider` / `createProvider` / 默认函数 / 默认对象；
- 调工厂（传 `{ root }`，适配器可把照片写进这个目录）；
- 校验返回值必须有 `status()`；
- 所有返回值经过统一契约层：状态 / 能力 / 参数描述结构、实时取景 JPEG / PNG 签名与体积、
  快门文件名、参数值和调用超时；
- 第三方适配器卡死时只让当前相机请求失败，不把整个桥挂住。

错误都翻成能照着做的中文：

- `相机适配器文件不存在：…`
- `相机适配器必须导出 createCameraProvider({ root })…`
- `相机适配器必须返回一个带 status() 的对象`
- `相机适配器启动失败（SDK not ready）。确认相机已连接、SDK 已初始化。`

## 5. 安全边界

- 适配器是**本机 Node 模块**，拥有完整进程权限；只加载自己信任的代码。
- 照片目录接口仍然只读；快门 / 参数接口要求 `x-pinkrose-camera: 1` 标记。
- 跨设备访问仍然要求访问令牌（`--host 0.0.0.0` 自动生成）。
- 适配器返回的 `saved` 只是文件名，实际文件仍走 `root` 下的安全路径校验。
- `saved` 不接受目录分隔符、`.` 或 `..`，防止厂商 SDK 返回值跳出相机目录。

## 6. 验证

- `server/cameraProvider.test.ts`：none / mock / gphoto2 分派；ESM 工厂、
  CommonJS 对象、缺文件、没有工厂、返回值不合法、工厂抛错。
- `server/canonCcapi.test.ts`：用本地假相机验证 CCAPI 版本发现、机型 / 电量、
  参数 schema 与写回、实时取景 JPEG、快门后新文件发现、存储卡导入与去重。它不能代替真实
  Canon 机身验收。
- `server/sonyCamera.test.ts`：用本地假相机验证远程模式、参数读写、二进制
  实时取景帧解析、快门下载、日期视图存储卡导入、模式恢复和断线提示；
  不能代替真实 Sony 机身验收。
- 真实 Node 动态 import 用临时 `.mjs` 跑一次 CLI 冒烟：`/control`、
  `/liveview`、`/shutter` 三条接口。
- `npm run camera:probe -- --provider ./my-adapter.mjs` 做无拍摄体检：
  连接状态、能力 / 方法一致性、实时取景帧、参数读取；只有
  `--probe-write` 才把当前参数原值写回一次，始终不按快门。
- 适配器返回值还必须通过状态 / 参数 schema、JPEG / PNG 帧、安全文件名和
  调用超时校验。
- `npm run typecheck` / `npm test` / `npm run build`。
