import { Btn } from './kit/Btn.tsx'

/**
 * 「这张照片怎么办」——照片操作条（★ 2026-10-08 从 `App.tsx` 拆出来，
 * DOM 一个字没改；测试按文字点这里的三颗按钮：`topbarButtons()`）。
 *
 * ★★ 2026-10-09：**它从顶上搬到了舞台底下那条灰带里**（用户截图 + 原话：
 *   「**这一行不要了，放在照片下面的灰色地带**」）。外面那层壳从
 *   `<header className="topbar">` 变成 `<div className="actions stage-bar">` ——
 *   `.topbar` 整条撤了（里面从此一个东西都没有）。贴边和高度由
 *   `.workspace .stage > .stage-bar` 管，见那段注释。
 *
 *   ⚠️ **`.actions` 这个类名故意不改**：测试和两个探针全都按 `.actions button`
 *   找这三颗（`topbarButtons()`、`check-mobile-layout.mjs` 的"顶栏按钮"那行），
 *   改名等于让它们静默腐烂。
 *
 * 沿革（它为什么一路往下搬）：2026-10-03 它先从"顶着品牌名的顶栏"瘦成"这张照片
 * 的操作条"—— 左边品牌名、右上角那颗 👤 都撤了（👤 搬去左栏的「个人设置」，
 * 见 `ui/Nav.tsx`）。那之后这条横杠就只剩按钮了，那就没有理由在**还没有照片**的
 * 时候摆一条空杠占着地方。
 * ★ 2026-10-04：里面最左边那颗「调色」也搬去了左栏（用户：「那个微调照片的放在
 * 导航栏单列出来」）。它本来就格格不入：这三颗是**把图拿走**（下载 / 保存 /
 * 新的一张），那颗是**改这张图**。搬走之后这一条自己成立了一个说法 ——
 * **"这张照片怎么办"**。
 * ★ 2026-10-09：最后连这条横杠也不要了 —— 三颗按钮搬进舞台底下那条灰带
 * （那块地方本来只是照片下面的一圈留白，见 `styles.css` 的 `--stage-gap`）。
 */
type Props = {
  /** 本设备认不认系统分享面板（手机认、桌面 Chrome 不认）—— 决定那一格是
   *  「分享」还是「下载」。App 只在挂载时算一次：设备能力不会中途变。 */
  canShare: boolean
  /** 正在导出的是哪一个（几颗按钮共用一个"忙"，同一时刻只可能有一颗在转）。 */
  delivering: 'share' | 'download' | 'save' | 'copy' | 'platforms' | 'live' | null
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
  /** 「导出设置」那一块（格式 / 质量 / 尺寸）。不传 = 只有默认快捷导出。 */
  exportSettings?: React.ReactNode
}

export default function TopActions({
  canShare, delivering, onShare, onDownload, onSave, onNew, busy, exportSettings,
}: Props) {
  return (
    <div className="actions stage-bar">
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
      {exportSettings}
    </div>
  )
}
