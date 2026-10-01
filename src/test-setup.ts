/**
 * 全局测试开关（vitest 的 `setupFiles`，见 vite.config.ts）。
 *
 * ⚠️ React 18 的 `act()` 需要这个全局变量为 true。不设的话，每次状态更新
 * 都会往控制台刷一行
 * `Warning: The current testing environment is not configured to support act(...)`
 * —— 本来用来提示"你漏了 act"的告警会变成噪声（引了 Base UI 之后，
 * 一条滑块就能刷好几行），真出问题时反而看不见。
 *
 * 它**不是**把警告关掉，而是把 act 环境打开：漏了 act 的地方照旧会红。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
