# 界面外观偏好设计 —— 2026-10-19

## 0. 目标

设置页补上「界面外观」，让用户可以在深色 / 浅色之间切换。

- 默认仍是深色：修图时减少环境光对照片明暗和色温判断的影响；
- 浅色给白天、投影、系统本身偏亮的场景；
- 只作用于登录后的 App 内页（`.shell`），落地页 / 登录页继续跟随系统。

## 1. 存储与同步

账号偏好字段：

```json
{ "appearance": "dark" }
```

- 合法值只有 `dark` / `light`；缺失 / 坏值按 `dark`。
- 本机 `localStorage` 键 `pinkrose.appearance`；登录后账号值覆盖本机。
- 保存时先写本机，再按字段合并进账号 `users.prefs`；网络失败时本机立即生效，
  设置页明确说「账号同步没成功」。

## 2. 渲染

`.shell` 加 `data-theme`：

```css
.shell[data-theme="light"] { color-scheme: light; }
.shell[data-theme="dark"] { color-scheme: dark; }
```

`:root` 的颜色全部是 `light-dark(浅, 深)` 成对值；只切换 `.shell` 的
`color-scheme`，壳内所有令牌就地重算。不新增第二套颜色，避免深浅两份互漂。

## 3. 边界

- 不把落地页 / 登录页一起切色：它们是门面，跟随系统。
- 不改变照片像素、导出文件或调色参数；只是界面 chrome。
- 默认深色不变；用户不选时不会因为系统是浅色就自动改编辑器。

## 4. 验收

- `appearance.test.ts`：归一化、本机读写。
- `App.account.test.tsx`：切浅色 → `.shell[data-theme]`、PATCH
  `preferences.appearance`、本机值；账号里的值登录后覆盖本机。
- WebKit 390px / 桌面：浅色编辑器、设置页都不横向溢出，文字可读。
