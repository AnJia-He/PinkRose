# 可视编辑历史设计 —— 2026-10-19

## 目标

账本已经有 `past / future`，但用户只看到「上一步 / 下一步」和一个数字。
这一轮把它变成可读、可直达的历史：

- 调色屏左下角的「2 / 3」变成按钮，点开列出当前这一版的每一笔；
- 每一笔有名字（原图 / 裁剪 / 调色 / 磨皮 / 形状 / 贴纸…）；
- 点任意一笔直接跳过去，不需要连按很多次箭头；
- 仍在当前这一版的账本内，不切版本、不写对话、不花钱。

## 契约

- `EditState` 带 `label`，`Snapshot` 带 `editLabel`；旧数据 / 夹具可以不给，
  读取时回退到「调整」「原图」，不改变任何像素判断。
- `jumpLedger(s, index)` 是纯函数：目标之前进 `past`、之后进 `future`，
  目标成为当前位置；越界夹到两端，已经在目标上返回同一引用。
- `pushEdit` / `undoEdit` / `redoEdit` 都要把名字跟着状态一起搬。
- `StepNav` 仍然不认识 `history`；它只收 `items` 和 `onJump`，由 App 接线。
- 点外面 / Escape 收起；`aria-expanded`、`aria-current` 和菜单角色齐备。

## 验收

- `core/ledger.test.ts`：标签随跳转移动，`future` 不丢。
- `ui/StepNav.test.tsx`：展开、点击跳转、Escape / 点外面收起。
- `App.adjust.test.tsx`：裁剪后展开历史，点「原图」画面真的回去。
- 真 WebKit：390px 历史列表在视口内，点击后计数和画面都变。
