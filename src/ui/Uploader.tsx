import { useRef, useState } from 'react'
import { Btn } from './kit/Btn.tsx'
import logoMark from '../assets/logo/profile.webp'

type Props = {
  /** 选好照片了。`wish` 是用户**在对话区里先打的那句话**（没打就是空串）——
   *  它会被带进对话输入框里，用户按一下发送就行。 */
  onPick: (file: File, wish: string) => void
}

/**
 * 上传前那一屏 —— **登录之后看到的第一张脸**。
 *
 * ★ 2026-10-03 重做（用户原话：「这边直接设立对话区，就像主流的 AI 软件对话一样，
 * 显示欢迎使用 PinkRose」）。改的是**形状**，不是内容：
 *   · 原来是一个大虚线框（`<label>` 当按钮）+ 三句提示；
 *   · 现在中间是一条**对话输入框**（`.composer`）：左边是话、右边是「选照片」，
 *     输入框空着时那颗按钮就叫「选照片」，打了字之后叫「发送」——
 *     和 ChatGPT / 豆包那一排长一样。**照片仍然是前提**（产品就是改照片的），
 *     所以按「发送」时如果还没选照片，对话框会弹出来，同时说一句"这句话我先记着"。
 *
 * ★ 2026-10-03 当天又减了一轮：用户看过这一屏之后说「**这些全都不要**」，
 *   **三样一起下线**（别再顺手加回来）——
 *   · 示范句那三个胶囊（连带前面那句"不知道从哪说起？点一个试试"）；
 *   · 「也可以把照片直接拖到这一块上。」；
 *   · 「一天大概能改二十来张照片。」
 *   现在这一屏只剩三样东西：标志、一句话说清这是什么、那条对话输入框。
 *   （额度那句为什么被拿掉，见 docs/文案规范.md「额度怎么说」那一节。）
 *
 * 还留着的那两条老规矩（它们是这一屏的价值所在）：
 *   · **一句话说清这是什么** —— 「说句话，照片就修好了」，和落地页 h1 是同一句；
 *   · **一个动作**（选一张照片 / 拖进来）—— 手机上点相册、桌面上拖进来，两条路都要有。
 *     拖进来那句**提示**虽然下线了，**能力还在**（三个拖放事件仍旧挂在整块 `.welcome` 上）：
 *     桌面用户随手拖一张进来，输入框会亮起来接住它。
 *
 * ⚠️ 拖放那三个事件挂在**整块 `.welcome`** 上（不是只挂在输入框那一行）：
 * 一行输入框太窄，而"拖到哪儿算数"要和"看着能不能放"对得上 —— 所以拖进这一块
 * 的任何地方都算，并且此时输入框自己亮起来给反馈（`over`）。
 * ⚠️ `onDragOver` 必须 `preventDefault()`，否则浏览器不认这是一次放置
 * （HTML 规范：默认行为是"不接收"），`onDrop` 根本不会触发。
 * ⚠️ 那个 `input[type=file]` **必须留在 DOM 里**（藏起来、由按钮去点它）：
 * `check:layout` 靠 `waitForSelector('input[type="file"]')` 判断"这一屏到了没有"。
 */
export default function Uploader({ onPick }: Props) {
  /** 拖到了这一块里没有。纯视觉 —— 不参与任何判断。 */
  const [over, setOver] = useState(false)
  /** 对话区里先打的那句话。 */
  const [wish, setWish] = useState('')
  /** 打了字、但还没选照片就按了发送 —— 提示一句，别让人以为按钮坏了。 */
  const [nag, setNag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const take = (files: FileList | null | undefined) => {
    const f = files?.[0]
    if (f) onPick(f, wish.trim())
  }

  /** 「发送」和「选照片」是**同一颗按钮**，只是输入框里有没有话决定了它叫什么。
   *  两条路都要开文件框 —— 照片是前提，话可以先说。 */
  const start = () => {
    setNag(wish.trim().length > 0)
    fileRef.current?.click()
  }

  return (
    <div
      className="welcome"
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files) }}
    >
      {/* 56px：44 的时候这朵花只是一团粉色（花瓣的层次全糊掉了），
          而它下面是这屏最大的一行字 —— 标志比标题还小会显得没底气。 */}
      <img className="welcome-mark" src={logoMark} alt="" width={56} height={56} />
      <h1 className="welcome-title">欢迎使用 PinkRose</h1>
      <p className="welcome-lede">
        说句话，照片就修好了。旅游拍的、路上随手拍的都行。
      </p>

      {/* ── 对话区 ─────────────────────────────────────────────────────
          它长成对话输入框的样子，但**不是**聊天入口：这一屏还没有照片，
          能做的第一步永远是"选一张"。所以它是一颗**会改名的按钮** ——
          空着叫「选照片」，打了字叫「发送」，按下去都是开文件框。 */}
      <form
        className={`composer${over ? ' over' : ''}`}
        onSubmit={e => { e.preventDefault(); start() }}
      >
        <input
          ref={fileRef}
          className="composer-file"
          type="file"
          accept="image/*"
          onChange={e => take(e.target.files)}
        />
        <input
          className="composer-text"
          value={wish}
          onChange={e => { setWish(e.target.value); setNag(false) }}
          placeholder="想怎么改，说一句…"
          aria-label="想怎么改"
          autoComplete="off"
        />
        {/* ⚠️ 主按钮**走 `<Btn>`**（全站只有一份长相那条规矩），
            这里只给它尺寸/圆角（`.composer-go` 在 styles.css 里）。 */}
        <Btn type="submit" className="composer-go">
          {wish.trim() ? '发送' : '选照片'}
        </Btn>
      </form>

      {/* 打了字却没选照片 → 说一句。**不是报错**，是告诉他这句话不会白打。 */}
      {nag && (
        <p className="composer-nag">选一张照片，这句话会一起带过去。</p>
      )}
    </div>
  )
}
