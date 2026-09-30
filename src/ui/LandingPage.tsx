import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
// ⚠️ 样式表**不在这儿 import** —— 它在 `src/main.tsx` 里、排在 `styles.css` 后面。
// 这一页有几条规则要盖掉全局的（body 底色、文档滚动条、color-scheme），
// 而那份顺序是有讲究的，理由写在那边的导入语句上。
import logo from '../assets/logo/rose.svg'
import seaRoad from '../assets/landing/sea-road.jpg'
import nightView from '../assets/landing/night-view.jpg'
import oldTown from '../assets/landing/old-town.jpg'
import seasideBack from '../assets/landing/seaside-back.jpg'
import nightMarket from '../assets/landing/night-market.jpg'
import highway from '../assets/landing/highway.jpg'
import beforeShot from '../assets/landing/before.jpg'
import afterShot from '../assets/landing/after.jpg'
import appWindow from '../assets/landing/app-window.webp'
import appPanel from '../assets/landing/app-panel.webp'

/**
 * 落地页 —— **打开网站看到的第一眼**（2026-09-30 从
 * `create-image/落地页/mock4.html` 那份 v4 样页搬进来的）。
 *
 * ⚠️ **版面和文案一个字都没改**，改的只有三件工程上的事：
 *   ① 那份 `<style>` 收进 `src/landing.css` 的 `.lp` 作用域，类名和 CSS 变量
 *      全加 `lp-` 前缀（App 里也有 `.nav`/`.brand`，同名会打架）；
 *   ② 那段内联 `<script>`（进场 / 回顶部 / 对开滑块）改成 React；
 *   ③ 图片从 `create-image/落地页/` 搬进 `src/assets/landing/` 并**入了库**
 *      —— 它们就是页面的内容，不入库的话换台机器 clone 下来这一页是空的。
 *
 * ⚠️ **这一页的配色和 App 不是一套，这是有意的**：落地页是门面（浅色、
 * 黄点缀、大留白），App 是干活的工具（深色、粉点缀、密）。两种语境两套语言；
 * 分家之前 App **自己内部**有过三套语言，那种才是病。
 *
 * 交互只有三处，都不引依赖：
 *   · `.lp-rise` 进场（IntersectionObserver，滚到眼前才升起来）；
 *   · 右下角回顶部（滚过一屏才出现）；
 *   · 对开滑块（一个 range 输入 + 一个 CSS 变量）。
 */
type Props = {
  /** 「免费开始」和「登录」都走它 —— 交出去的是"去 App"这个意图，
   *  往哪个网址放是上层的事（规则只有 `ui/view.ts` 那一份）。 */
  onEnter: () => void
}

/**
 * 进场：滚到眼前才轻轻升起来。
 *
 * ⚠️ 它是**每个元素自己的一个小状态**，不是"进页面时 querySelectorAll('.lp-rise')
 * 挨个手动加 class"。后者是原版样页的写法（静态 HTML 里没有别的办法），
 * 搬到 React 里就有个隐患：手动加的 class **不在 React 的账上**，只要这个节点
 * 因为别的原因重渲染一次，就可能被打回原形、永远停在看不见的状态。
 * 十几行换掉一个"偶尔会失灵"的形状，值。
 */
function Reveal({ children, className = '', style }: {
  children: ReactNode; className?: string; style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    // 没有 IntersectionObserver、或者用户关掉了动效 → **直接亮出来**。
    // 少了这一条，那种环境下整页内容会永远停在 `opacity: 0`（白屏）。
    if (!el || !('IntersectionObserver' in window) ||
        matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { setShown(true); io.disconnect() }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} style={style}
         className={`lp-rise${shown ? ' lp-in' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

/** 右下角那个浮标。**它是能用的，不是装饰** —— 这一页很长。 */
function BackToTop() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // 滚过一屏才出现。监听是 passive 的（不阻塞滚动），而且
    // `setShow` 收到同一个值时 React 自己会 bail out，不必再手写去重。
    const onScroll = () => setShow(window.scrollY > window.innerHeight)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="lp-dock">
      <button
        className={show ? 'lp-show' : ''}
        aria-label="回到顶部"
        title="回到顶部"
        onClick={() => window.scrollTo({
          top: 0,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        })}
      >↑</button>
    </div>
  )
}

/** 「同一张照片，一句话的差别」那个对开滑块。拖它 = 改一个 CSS 变量。 */
function BeforeAfter() {
  const [pos, setPos] = useState(52)
  return (
    <>
      {/* ⚠️ 自定义属性得走内联 style，而且 TS 不认 `--lp-p` 这种名字，
          所以要断言一次类型（`CSSProperties` 里根本没有这种键）。 */}
      <Reveal className="lp-ba" style={{ '--lp-p': `${pos}%` } as CSSProperties}>
        <img src={beforeShot} alt="手机直出的原图" />
        <img className="lp-after" src={afterShot} alt="调色之后的同一张照片" />
        <div className="lp-handle" />
        <input
          type="range" min={0} max={100} value={pos}
          aria-label="拖动对比原图和调色后"
          onChange={e => setPos(Number(e.target.value))}
        />
      </Reveal>
      <Reveal className="lp-ba-legend">
        <div><b>原图</b><span>手机拍完直接存下来的样子，平、灰、偏冷。</span></div>
        <div><b>调色后</b><span>暖一点、天更透、阴影抬起来。脸还是原来那张脸。</span></div>
      </Reveal>
    </>
  )
}

export default function LandingPage({ onEnter }: Props) {
  /** 点 CTA。**保留 `<a href>` 那半边**：中键、右键"在新标签打开"照旧能用，
   *  只是左键点的时候不让浏览器真的走一趟整页加载（那是 SPA 里的倒退）。 */
  const enter = (e: React.MouseEvent) => { e.preventDefault(); onEnter() }

  useEffect(() => {
    // `body` 的底色、`color-scheme`、**文档滚动条**这三样是文档级的，
    // 写在 `.lp` 里面管不到它们 —— 所以挂一个类到 `<html>` 上，
    // 那几条规则在 landing.css 末尾。
    const root = document.documentElement
    root.classList.add('lp-on')
    const prevTitle = document.title
    document.title = 'RuiXing —— 说句话，照片就修好了'

    return () => {
      root.classList.remove('lp-on')
      document.title = prevTitle
      // ★ **离开这一页必须把文档滚回顶上。**
      //   App 那边是"锁在一屏内、自己内部滚"（`.shell{height:100vh}`），
      //   文档要是还停在这一页滚下去的位置，整个 App 会被顶上去一截 ——
      //   用户点完「免费开始」看到的会是一个缺了上半截的界面。
      window.scrollTo(0, 0)
    }
  }, [])

  return (
    <div className="lp">
      <div className="lp-grain" aria-hidden="true" />

      <BackToTop />

      <header className="lp-nav">
        <div className="lp-wrap">
          <span className="lp-brand"><img src={logo} alt="" />RuiXing</span>
          {/* 导航那三个词（2026-09-30 用户改过一轮）。
              原来写的是「怎么用 / 效果 / 不必担心」—— 用户的原话是
              **「换个专业的说法，现在太口语化了」**，跟着补了一句
              **「也不要太专业」**（我先给的「产品功能 / 使用保障」那一组被否了）。

              所以尺度落在中间：**三个都是完整的短语、长度接近**（原来看起来像
              聊天里截出来的半句），但**一个行业词都没引进来**，也**不再对着读者
              说话**（「不必担心」那种是劝，指路牌不该劝）。
              换的三个词各自贴着它指向的那一节：
                · `怎么改`     ← h2「你想怎么改，说一声」
                · `效果对比`   ← h2「同一张照片，一句话的差别」（就是那个对开滑块）
                · `不怕改错`   ← h2「改错了，回得来」 */}
          <nav>
            <a href="#product">怎么改</a>
            <a href="#compare">效果对比</a>
            <a href="#how">不怕改错</a>
          </nav>
          <a className="lp-login" href="/app" onClick={enter}>登录</a>
        </div>
      </header>

      {/* ══ 开场 ═════════════════════════════════════════════════════ */}
      <section className="lp-hero">
        <img className="lp-hero-bg" src={seaRoad}
             alt="傍晚的海边公路上，一个人举着手机对着海面拍照" />
        <div className="lp-hero-inner">
          <div className="lp-wrap">
            <h1>说句话，<br />照片就修好了</h1>
            <p>拍的时候顾不上。回来一看，光不对，天太灰，身后还站着不认识的人。不用重拍。</p>
            {/* ★ 2026-09-30：「免费试用」→「**免费开始**」。
                理由不是"免费"有问题（今天确实不要钱），是**"试用"蕴含了一个
                还没发生的承诺** —— 它暗示"试完之后要付费"，而"免费额度怎么定"
                这件事在产品里**还没定案**（设计缺口里躺着："一次生成约 1.3 万
                tokens，白送烧不起"）。
                「免费开始」只承诺"开始这一步不要钱" —— 无论以后额度怎么定，
                这句话都是真的。等额度定了，该写在**定价/额度那一页**，不是按钮上。 */}
            <a className="lp-btn lp-btn-accent" href="/app" onClick={enter}>免费开始</a>
          </div>
        </div>
      </section>

      {/* ══ 产品 ═════════════════════════════════════════════════════ */}
      <section id="product">
        <div className="lp-wrap">
          <Reveal>
            <h2>你想怎么改，说一声</h2>
            <p className="lp-lede">「天空再蓝一点」「后面那个人去掉」「脸太暗了」。你平时怎么跟朋友形容，就怎么说。想自己调，也可以拖滑块。</p>
          </Reveal>
        </div>
        <div className="lp-bleed">
          <Reveal className="lp-prod">
            <div className="lp-prod-base">
              <img src={appWindow} alt="RuiXing 修图界面，左边是照片，右边是对话和建议卡片" />
            </div>
            <div className="lp-prod-float">
              <img src={appPanel} alt="展开的调色面板，六套风格预设和八条调整滑块" />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ══ 引擎 ═════════════════════════════════════════════════════
          ★ 2026-09-30 改过一段 —— **这一段原来有两句是假话**：
            「不用上传」「山里没信号也照样改」。

          事实是：拖滑块 / 套预设走的是本地 WebGL，确实不出设备；
          但**说一句话就会把一张 1024 的预览送到服务器**让模型看，
          而「把后面那个人去掉」那类要把整张图送云端 —— **必须联网**。

          改法是行业里被认可的那一套（Apple 讲「私密云计算」就是这么讲的）：
          **不声称"不联网"，而是说清哪半在设备上、哪半要发出去。**
          把本地那半说成优点（"在你自己手机里算的"），比笼统喊"不上传"可信得多 ——
          而且"不用上传"这种话**已经被读者警惕了**（搜"端侧AI 本地处理"能看到
          一整批"别被这四个字骗了"的文章），说它是两头输。

          ⚠️ 底下那句「免费试用」也改成了「免费开始」：见页面最下面那处注释。 */}
      <section className="lp-deep" id="engine">
        <div className="lp-wrap">
          <Reveal>
            <h2>当场就变，山里也能改</h2>
            {/* ⚠️ 两句话**写在同一个字符串里**，不能像别处那样换行写：
                JSX 会把换行折成一个空格，于是中文句号后面会多出一个空格 ——
                中文排版里句号后面不留空格，那一个空格在页面上看得见。 */}
            <p className="lp-lede">{'拖滑块、换预设是在你自己手机里算的，不联网也照样用。要「把后面那个人去掉」这种本事，得让云上的模型看一眼这张照片，那一步需要联网。'}</p>
          </Reveal>
        </div>
      </section>

      {/* ══ 效果 ═════════════════════════════════════════════════════ */}
      <section id="compare">
        <div className="lp-wrap">
          <Reveal>
            <h2>同一张照片，<span className="dim">一句话的差别</span></h2>
            <p className="lp-lede">左边是手机直出，右边是调完之后。中间那条线可以拖。</p>
          </Reveal>
          <BeforeAfter />
        </div>
      </section>

      {/* ══ 怎么用 ═══════════════════════════════════════════════════ */}
      <section id="how">
        <div className="lp-wrap">
          <Reveal><h2>改错了，回得来</h2></Reveal>
          <Reveal className="lp-bento">
            <div className="lp-cell lp-photo">
              <img src={nightMarket} alt="夜市小吃街，摊子上的锅冒着热气" />
              <div className="lp-cap">
                <h3>每一步都退得回去</h3>
                <p>每一步都挂在对话里，点哪一句，就回到哪一句。调色不伤原图，照片随时能回到刚上传的样子。</p>
              </div>
            </div>
            <div className="lp-cell">
              <h3>说不清，就拖滑块</h3>
              <p>「亮一点」「暖一点」「天再蓝一点」，说什么都行。说不出来，拖一下滑块也可以。</p>
            </div>
            <div className="lp-cell">
              <h3>发出去的，还是你拍的那张</h3>
              {/* ★ 2026-09-30 改。原来写的是「尺寸一点没缩」—— 绝对话，而它在
                  **浏览器扛不动超大图**那一档是假的（那种情况 App 会先缩一档，
                  而且它自己老实说了"导出的图会比原图小一点"，落地页却说得斩钉截铁）。
                  改成**把例外说出来**：敢说"例外也会告诉你"比声称"没有例外"更可信 ——
                  和上面那段同一个道理。 */}
              <p>尺寸、拍摄时间、地点，都原样留在文件里。唯一的例外是手机扛不动的超大图 —— 那种情况我们会当场跟你说清楚。</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ══ 收尾 ═════════════════════════════════════════════════════ */}
      <section className="lp-final">
        <div className="lp-wrap lp-lead-wrap">
          <Reveal>
            <h2>下一张朋友圈</h2>
            <p className="lp-lede">不用装软件，不用先学。打开就能用。</p>
            <a className="lp-btn lp-btn-ink" href="/app" onClick={enter}>免费开始</a>
          </Reveal>
        </div>
        <Reveal className="lp-rail">
          <figure><img src={highway} alt="高原公路和远处的雪山" /></figure>
          <figure><img src={oldTown} alt="古镇巷子里回头笑的女生" /></figure>
          <figure><img src={nightMarket} alt="夜市小吃街" /></figure>
          <figure><img src={nightView} alt="山顶看城市夜景" /></figure>
          <figure><img src={seasideBack} alt="海边沙滩上牵手往前走的两个人" /></figure>
          <figure><img src={seaRoad} alt="傍晚的海边公路" /></figure>
        </Reveal>
        <footer className="lp-footer">
          <div className="lp-wrap">
            <span>RuiXing</span>
            <span>一句话，把旅途中的照片修好</span>
          </div>
        </footer>
      </section>
    </div>
  )
}
