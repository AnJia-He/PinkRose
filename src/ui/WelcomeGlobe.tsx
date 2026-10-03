import seaRoad from '../assets/welcome/sea-road.webp'
import nightView from '../assets/welcome/night-view.webp'
import oldTown from '../assets/welcome/old-town.webp'
import seasideBack from '../assets/welcome/seaside-back.webp'
import nightMarket from '../assets/welcome/night-market.webp'
import highway from '../assets/welcome/highway.webp'
import beforeShot from '../assets/welcome/before.webp'
import afterShot from '../assets/welcome/after.webp'

/**
 * 上传前那一屏的**背景**：一堆照片排成一颗球，绕竖轴**朝一个方向**慢慢转。
 *
 * ★ 2026-10-03 用户要的（原话）：「在这个对话框的背景我想做成一个背景为多个
 * 图片朝一个方向转动的图片球体」。
 *
 * ⚠️ **没有引任何 3D 库**，用的是 CSS 自己的 3D：每一格照片摆在一个球面上
 * （`rotateY(经度) rotateX(纬度) translateZ(半径)`），外层挂一条
 * `rotateY(360deg)` 的无限动画。球的半径在 CSS 的 `--globe-r` 里 ——
 * 这里引的就是那个变量，**别在这边另外写死一个数**（改半径只该改一处）。
 *
 * 位置怎么分的（这一句是关键）：**斐波那契格点**（相邻点差一个黄金角）——
 * 按经纬度均匀撒的话两极会挤成一堆、赤道又稀，球会看着一头重一头轻。
 * 8 张照片在格子上一张一张轮流摆 —— 素材本来就只有 8 张（就是落地页那 8 张
 * 旅游照，压成了 240×160 的小图，见 `_globe_thumbs.py`）。
 *
 * ⚠️ **所以正面能同时看到的两三格会是同一个画面**（8 张铺满一颗球，数学上
 * 躲不掉 —— 轮流摆已经是"同一张尽量隔远"的排法了）。格数摆多了这个越明显，
 * 40 出头是看着刚好的一档。想彻底解决只有一条路：**再多拍几张照片**，
 * 不是调参数能调掉的。
 *
 * ⚠️ 它是**背景**，三条硬约束：
 *   · `pointer-events: none`（CSS 里）—— 不然往这一屏拖照片会被这些图挡住；
 *   · `aria-hidden` —— 读屏软件不必知道背景上飞着 40 张图；
 *   · 每一格 `alt=""` + `draggable={false}` —— 别让浏览器起一次"拖动图片"。
 */
const PHOTOS = [
  seaRoad, nightView, oldTown, seasideBack,
  nightMarket, highway, beforeShot, afterShot,
]

/**
 * 球上有几格。
 * ⚠️ **别往上调太多**：每一格都是一个真 `<img>`，40 格在手机上已经要占 40 层
 * 合成。8 张图只有 31KB（会复用同一份解码结果），**贵的是层数、不是图**。
 */
const TILES = 44

/** 预先算好每一格的经纬度 —— 这是一堆常量，不必每次渲染重算。 */
const LAYOUT = Array.from({ length: TILES }, (_, i) => {
  // y: 1 → -1（从上到下），±1 那两个端点会挤，所以从半个格宽开始
  const y = 1 - (i + 0.5) * 2 / TILES
  // ⚠️ 纬度**卡在 ±72 度**，不用满 ±90：贴到两极的那些格子几乎是"侧着"的
  //    （只剩一条细缝），看着像球上粘了几片碎渣。收一下之后两极也铺得满、
  //    而且每一格都还是"一张照片"的样子。
  const lat = (Math.asin(y * 0.95) * 180) / Math.PI
  const lon = (i * 137.508) % 360 - 180        // 黄金角，转一圈铺开
  return { lat, lon, src: PHOTOS[i % PHOTOS.length] }
})

export default function WelcomeGlobe() {
  return (
    <div className="globe" aria-hidden="true">
      <div className="globe-spin">
        {LAYOUT.map((t, i) => (
          <img
            key={i}
            className="globe-tile"
            src={t.src}
            alt=""
            draggable={false}
            style={{
              transform: `rotateY(${t.lon.toFixed(2)}deg) rotateX(${t.lat.toFixed(2)}deg)` +
                ' translateZ(var(--globe-r))',
            }}
          />
        ))}
      </div>
    </div>
  )
}
