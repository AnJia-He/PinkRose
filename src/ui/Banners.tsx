import { Btn } from './kit/Btn.tsx'
import { downloadImage } from '../export/save'

/**
 * 顶头那三条横幅（★ 2026-10-08 从 `App.tsx` 拆出来，DOM 一个字没改）。
 *
 * 它们是**三种东西，别合并**：
 *   · `.notice`（通报条，取代了原来的 `window.alert`）—— "这件事没成 / 成了"，
 *     可以收走；
 *   · `.ask` —— **在问用户一句话**（"上次那张要替换掉吗"）；
 *   · `.save-fail` —— "图还在，先拿到手"（自带下载按钮，而且不许关）。
 * 三块都排在最上面（有照片时在操作条底下、没有时自己就是第一条）、都按"一整条
 * 横幅"排，所以它们并排出现时读起来是一列消息，不是三坨按钮。
 */
type Props = {
  /** 通报条那句话 + 语气（`ok` 几秒后自己走，`bad` 留着等用户点掉）。 */
  notice: { text: string; tone: 'ok' | 'bad' } | null
  onDismissNotice: () => void
  /** 非 null = 正在问"上次那张要替换掉吗，手里攥着刚做好的那张图"。 */
  asking: boolean
  /** 上一次存进作品的是哪个 —— 「替换」交出去的那个 id。 */
  savedId: number | null
  /** 「替换」交 `savedId`、「再存一张」交 `null`。 */
  onAnswerAsk: (replaceId: number | null) => void
  /** 存失败时留下的图 + 名字 + 原因（`blob` 为 null = 图根本没做出来）。 */
  saveFail: { blob: Blob | null; name: string; why: string } | null
  onDismissSaveFail: () => void
}

export default function Banners({
  notice, onDismissNotice, asking, savedId, onAnswerAsk, saveFail, onDismissSaveFail,
}: Props) {
  return (
    <>
      {notice && (
        <div className={notice.tone === 'ok' ? 'notice ok' : 'notice'}>
          <p>{notice.text}</p>
          <button onClick={onDismissNotice}>知道了</button>
        </div>
      )}

      {/* 「上次那张要替换掉吗？」（§3.4）—— 同一张照片存第二次才会出现。
          ⚠️ **不放进 `.topbar`**：那一条是那四颗按钮的操作条，塞进去会把它们
          挤成一团（`check:layout` 量的正是这条会不会被挤爆）。贴在它**下面**
          也就贴在用户刚按的那个按钮的正下方 —— 问他话的地方就是他按的地方。 */}
      {asking && (
        <div className="ask">
          <p>上次那张要替换掉吗？</p>
          <button onClick={() => onAnswerAsk(savedId)}>替换</button>
          <button onClick={() => onAnswerAsk(null)}>再存一张</button>
        </div>
      )}

      {/* 存不进去（§6.6 ①）：**改好的图只在屏幕上**，所以当场给一个能拿到它的
          按钮。§10 说这条最容易漏 —— 漏了的话用户一关页面，那张图就没了，
          而他那一刻要的是发朋友圈；存不下是**我们这边的限制**。 */}
      {saveFail && (
        <div className="save-fail">
          {/* §6.6 ②：明确告诉他，不含糊 —— 只说"存不进去"他会以为图也没了。
              ⚠️ **两种失败要分两句话说。** `blob` 为 null 意味着图**根本没做出来**
              （`buildExportBlob` 那步就炸了），这时候说"图还在"是**假的** ——
              用户会去找一个屏幕上根本不存在的按钮。有图才说"图还在，先拿到手"。
              变异：把下面这个三目压成永远走第一句 → 那条断言红。
              ⚠️ **说的是「刚才那张」，不是「这一张」**（2026-09-25 改）。这条横幅
              **不随画面变消失**（故意的：清掉的话用户就再也拿不到那张图了，而他
              关掉横幅之后是**真的**拿不到了）。而屏幕上的画面是会变的 —— 他回头
              又改了一版（「把后面那个人去掉」生成一张新的底，或者点「回到这一步」
              退回某一步），这时候屏幕上那张**就不是**失败那一刻那张了：
              「这一张」指向屏幕上这张，而按钮给的是 `saveFail.blob` 里那张
              （失败那一刻做出来的）。**一句话和它对不上的行为，比没有这句话更糟。**
              （不是"换一张照片"那个场景：应用里没有换图入口 —— Uploader 只在
              还没有图的时候渲染，换图的唯一动作是重开一次，而重开会把横幅
              一起清掉，所以横幅边上从来不会出现"另一张照片"。见 App.test.tsx
              那条「换一张照片」的注释。）
              变异：把「刚才那张」改回「这一张」→ 那条「存失败之后又改了一版」的断言红。 */}
          {saveFail.blob
            ? <p>刚才那张没能存进「作品」。图还在，先拿到手：</p>
            : <p>刚才那张没能存进「作品」，图也没能导出来。再点一次「存进作品」试试。</p>}
          {/* 把"为什么"也说出来 —— 服务端给的那句话（「这张图太大了，存不下」）
              比「没存进去」有用得多。存了这个字段却从不显示，等于白存。 */}
          <p className="save-fail-why">{saveFail.why}</p>
          {saveFail.blob && (
            <Btn
              className="download"
              // ⚠️ 这个 `!` 是**结构上**安全的，不是"我保证"：它上面那行
              //    `{saveFail.blob &&` 已经把 false 那一支挡掉了，能渲染到这里
              //    就说明 blob 非 null。（而且不能把 `&&` 换成 `?.` —— `&&`
              //    也是"按钮出不出现"本身：没图就不该有这个按钮。）
              //    **别照着这里在别处也随手加 `!`**：换个地方它可能真的会是 null。
              onClick={() => downloadImage(saveFail.blob!, saveFail.name)}
            >
              {/* ★ 2026-10-11（设计跟进 T4）：原来叫「下载到电脑」——「把图拿到
                  手」这一个动作当时全站三个名字（顶栏「下载」/ 这里「下载到电脑」/
                  详情页「下载到我的电脑」）。统一成「下载」，和顶栏那一格同词。 */}
              下载
            </Btn>
          )}
          <button onClick={onDismissSaveFail}>知道了</button>
        </div>
      )}
    </>
  )
}
