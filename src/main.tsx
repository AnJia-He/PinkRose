import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// ★ 2026-10-07：**自带的中文字体**（MiSans VF，小米，免费商用；出处与许可见
// `THIRD_PARTY_NOTICES.md`）。这一份里全是 `@font-face`，放在最前面 ——
// 它不参与层叠胜负，只是"先告诉浏览器这些字从哪儿来，别急着用系统字排一遍"。
// ⚠️ 家族名是 `MiSans VF`；真正引用它的是 `styles.css` 的 `--font` 和
// `landing.css` 里 `.lp` 那条字体栈（两处都要跟，别只改一处）。
import './assets/fonts/misans/misans.css'
import './styles.css'
// ⚠️ **落地页那份必须排在 `styles.css` 后面。**
// 它有几条是要盖掉全局的：「`html.lp-on` 上的 `color-scheme` 和滚动条」、
// 「`html.lp-on body` 的底色」—— 因为 App 是深色、落地页是浅色，
// 而 `body` 的底色和文档滚动条这两样的归属是**文档级**的。
// 今天它们靠选择器权重也能赢（`html.lp-on` 0-1-1 打 `:root` 0-1-0），
// 但那是**碰巧**：哪天谁加一条同权重的规则，胜负就由这份导入顺序说了算。
// 与其让下一个人去猜，不如把顺序写死在这儿。
// 页面组件在 `ui/LandingPage.tsx`，那边留了指回来的路标。
import './landing.css'
import { registerPwa } from './pwa/register'

if (import.meta.env.PROD) registerPwa()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
