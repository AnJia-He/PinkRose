import { Btn } from './kit/Btn.tsx'

/**
 * 「这张照片怎么办」——照片操作条（★ 2026-10-08 从 `App.tsx` 拆出来，
 * DOM 一个字没改；测试按文字点这里的三颗按钮：`topbarButtons()`）。
 *
 * 它现在**只在有照片的时候才有**（★ 2026-10-03）。原来是一条常驻的横杠：
 * 左边品牌名、右边一颗 👤、中间这四颗按钮。用户指着那一屏说「**这个一行都不要**，
 * 个人设置放到首页下面」—— 品牌名整个下线（顶栏不再挂名字；门面和登录页那两处
 * 还都在），👤 搬去了左栏（见 `ui/Nav.tsx` 的「个人设置」）。
 * 这条横杠当场就只剩这四颗按钮了 —— 那就没有理由在**还没有照片**的时候摆一条
 * 空杠占着地方：它们本来就只在有照片可操作的那一刻才有用。
 * 于是它现在**不是"顶栏"了，是"这张照片的操作条"**。
 *
 * ★ 2026-10-04：**里面那三颗现在真的是三颗了** —— 原来最左边那颗「调色」也搬去了
 * 左栏（用户：「那个微调照片的放在导航栏单列出来」）。它本来就格格不入：这三颗是
 * **把图拿走**（下载 / 保存 / 新的一张），那颗是**改这张图**。搬走之后这一条自己
 * 成立了一个说法 —— **"这张照片怎么办"**。
 */
type Props = {
  /** 本设备认不认系统分享面板（手机认、桌面 Chrome 不认）—— 决定那一格是
   *  「分享」还是「下载」。App 只在挂载时算一次：设备能力不会中途变。 */
  canShare: boolean
  /** 正在导出的是哪一个（几颗按钮共用一个"忙"，同一时刻只可能有一颗在转）。 */
  delivering: 'share' | 'download' | 'save' | null
  onShare: () => void
  onDownload: () => void
  onSave: () => void
  /** 「新的一张」= 回到上传前那一屏去选下一张（§6.4）。 */
  onNew: () => void
  /** 生成在跑（`busy !== null`）时「新的一张」要 disabled —— 理由见 App 那边。
   *  ⚠️ 传进来的**已经是布尔**（App 那边算好的 `busy !== null`）—— 这里再写一次
   *  `busy !== null` 会恒真、这颗按钮永远按不动（2026-10-08 拆件时踩过，
   *  四条用例当场红）。 */
  busy: boolean
}

export default function TopActions({
  canShare, delivering, onShare, onDownload, onSave, onNew, busy,
}: Props) {
  return (
    <header className="topbar">
      <div className="actions">
        {/* 这一格是**"把图给我"**，只是给法分两种，按这个设备认不认图片分享来选
            （`canShare` 只在挂载时算一次：设备能力不会中途变）。
            · 认 → 「分享」：弹系统面板，手机上一步选微信，跳过翻文件管理器。
            · 不认 → 「下载」：桌面 Chrome 就是这一档，见 onDownload
              —— 在那之前**桌面上根本没有把图拿到手的路**。
            两条路都给同一个东西（用户修好的那张图），所以它们是**同一格的两种
            长相**，不是两个按钮。 */}
        {canShare ? (
          <Btn className="primary" onClick={() => onShare()} disabled={delivering !== null}>
            {delivering === 'share' ? '准备中…' : '分享'}
          </Btn>
        ) : (
          <Btn className="primary" onClick={onDownload} disabled={delivering !== null}>
            {delivering === 'download' ? '准备中…' : '下载'}
          </Btn>
        )}
        {/* 「保存」= 存进作品集（§3.4）—— 它不再下载，所以走的是 `onSave`。
            ★ 2026-10-06（晚）：**字从「保存」改成「存进作品」** —— 用户提的那句
            "细节点不能模棱两可"：这一格和左边那颗（下载 / 分享）都是"把图留下"，
            而"保存"没说存到**哪儿**去。存进「作品」——名字和左栏那一支、和成功
            那声通报（「存好了，在左边「作品」里。」）说的是同一个地方。
            ⚠️ 改这三个字要**连带**改：App 里的 `saveFail` 横幅、「原图没取回来」
            那条通报、`App.test.tsx` 的 `topbarButtons()` 和那处 `click('保存')`、
            `scripts/check-mobile-layout.mjs` 和 `scripts/dump-copy.mjs`
            （它们按文字点这颗按钮）。 */}
        <button onClick={onSave} disabled={delivering !== null}>
          {delivering === 'save' ? '准备中…' : '存进作品'}
        </button>
        {/* 「新的一张」= 回到上传前那一屏去选下一张（§6.4）—— 它是**"我再改一张"**，
            和「保存」（把这张存进作品）是两件事。
            ⚠️ 它**不删**当前这条会话：那条已经在服务端上存着了，左栏「对话」里还
            找得到。
            ⚠️ 忙的时候 disabled：生成在跑的那十几秒里，那一次回来时会往 history 里
            写一步，而那时候这张照片早就不在屏幕上了。 */}
        <button onClick={onNew} disabled={busy}>新的一张</button>
      </div>
    </header>
  )
}
