import { useState } from 'react'
import logoMark from '../assets/logo/rose.svg'

type Props = { onPick: (file: File) => void }

/** 「选一张照片」那个框里的图。画的是一张照片（方框 + 山 + 太阳），
 *  不是"上传箭头"：用户要做的动作是"挑一张照片"，不是"上传"——
 *  这一屏上"上传"这个词一次都没出现过。
 *
 *  ⚠️ **2026-10-01 起这条理由改了**：原来这里写的是"内联 SVG，因为
 *  `dependencies` 永远只有 piexifjs / react / react-dom"—— 那条**零新依赖**的
 *  规矩被用户推翻了（见 `docs/superpowers/specs/2026-10-01-frontend-component-library.md`）：
 *  通用交互件一律用现成的库。所以这只手画的图**已经排进"换成 lucide"那一批**，
 *  在换掉之前先别再加新的手绘图标。 */
function PhotoIcon() {
  return (
    <svg className="uploader-icon" viewBox="0 0 24 24" width="30" height="30" fill="none"
         stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 15.5 16.2 11 10 17.2M3.4 16.6l3.1-2.7 3 2.6" />
    </svg>
  )
}

/**
 * 上传前那一屏 —— **登录之后看到的第一张脸**。
 *
 * 2026-09-30 重做。原来这里只有一个虚线框、里面四个字「选一张照片」，浮在
 * 一整片黑里：不说这是什么产品、不说能拿它干嘛、也不说该怎么做。用户看完
 * 整套界面的评语是「设计是不是过于简化了」—— 这一屏是那句话最直白的地方
 * （首屏投入的每一分都在这里回本，别处都没有它值钱）。
 *
 * 三个元素各管一件事，缺一个都能说出缺了会怎样：
 *   · **一句话说清这是什么**（「说句话，照片就修好了」）—— 和落地页 h1 是
 *     同一句，用户在门口读到的和进门读到的是同一句，不是一个门里一个说法；
 *   · **一个动作**（选一张照片 / 拖进来）—— 手机上点开相册、桌面上拖进来，
 *     两条路都要有：目标用户是手机党，但**他自己**是在桌面上试的；
 *   · **一句话示范怎么用**（那三个例子）—— 对话式修图是这产品最不一样的地方，
 *     而"可以对着一张照片说话"这件事不是自明的。三个例子照抄落地页那句，
 *     措辞一个字都没改。
 *
 * ⚠️ **拖放那三个事件挂在 `<label>` 上**，不是挂在外层容器：拖到哪儿算数，
 * 得和"点到哪儿算数"是同一块地方，否则框外一圈"看着能放、其实不认"。
 * ⚠️ `onDragOver` 必须 `preventDefault()`，否则浏览器不认这是一次放置
 * （HTML 规范：默认行为是"不接收"），`onDrop` 根本不会触发。
 */
export default function Uploader({ onPick }: Props) {
  /** 拖到了框里没有。纯视觉 —— 不参与任何判断，所以它可以什么都不影响。 */
  const [over, setOver] = useState(false)

  const take = (files: FileList | null | undefined) => {
    const f = files?.[0]
    if (f) onPick(f)
  }

  return (
    <div className="welcome">
      {/* 56px：44 的时候这朵花只是一团粉色（花瓣的层次全糊掉了），
          而它下面是这屏最大的一行字 —— 标志比标题还小会显得没底气。 */}
      <img className="welcome-mark" src={logoMark} alt="" width={56} height={56} />
      <h1 className="welcome-title">说句话，照片就修好了</h1>
      <p className="welcome-lede">
        旅游拍的、路上随手拍的都行。传一张上来，想怎么改就用大白话说。
      </p>

      <label
        className={`uploader${over ? ' over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files) }}
      >
        <input type="file" accept="image/*" onChange={e => take(e.target.files)} />
        <PhotoIcon />
        <span className="uploader-cta">选一张照片</span>
        <span className="uploader-hint">或者把照片拖到这里</span>
      </label>

      <p className="welcome-eg">
        不知道从哪说起？试试「天空再蓝一点」「后面那个人去掉」「脸太暗了」。
      </p>

      {/* ★ 2026-09-30 用户定案：**不写"免费额度"**（那种话读着像营销，
          而且额度策略本身还没定），只**提示一天大概能做多少** ——
          而且**单位是照片张数，不是 tokens**（用户的原话是"一次能改动多少照片"）。

          数从哪来：设计文档 §6.6 防滥用那一栏写的是「每人每天 **20 次**生成」，
          这里就照它说"二十来张"。

          ⚠️ 写"大概"、不写"最多"，是因为**这道闸门还没做** —— 真要拦是后端的事
          （现在是串行队列 + 上游 429 退避，没有计数）。文案说的是**预期**，
          不是已经生效的规矩。等哪天真加了闸门，这句再改成"今天还能改 N 张"。
          ⚠️ 也别在这儿写"免费"两个字（用户明确说了不写）：这句话里
          一个字都没提钱，是故意留的白。 */}
      <p className="welcome-note">一天大概能改二十来张照片。</p>
    </div>
  )
}
