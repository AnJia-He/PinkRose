// 页面 data 形状（后续任务只往里加字段，不改已有的）：
//   stage —— 'empty' 空态（选照片）/ 'edit' 编辑态（有照片）
//   photo —— 当前照片临时路径；空态 null
//   photoW / photoH —— 照片的像素尺寸（渲染任务按它摆布局）
//   stageW / stageH —— 画布**显示**尺寸（px）：照片等比装进照片区之后的大小。
//                      ⚠️ 画布的绘图缓冲是**照片原尺寸**（管线 resizeToImage 设的），
//                      这俩只管 CSS 盒子 —— 和电脑版同款分工：buffer 一个尺寸、
//                      显示另一个尺寸，CSS 负责缩放。
//   styles —— 风格栏 13 格（原图 + 12 预设）的视图数据（位置见 lib/image/thumbs.ts）
//   spritePath / spriteW —— 13 格拼成的那张 sprite 图（临时文件路径 + 显示宽，rpx）
//   activeStyle —— 当前亮着哪一格（共享 activePresetId 算的；null = 谁都不亮）
//   statusBar —— 状态栏高度，顶栏自己让位用
//   topbarPadRight —— 顶栏右侧给微信那颗胶囊（••• | ⊙）让出的宽度
import { ZERO, type Adjustments } from '../../lib/shared/adjustments'
import { activePresetId, ORIGINAL_ID, PRESETS } from '../../lib/shared/presets'
import { TonePipeline, type CanvasNode } from '../../lib/gl/tonePipeline'
import { renderThumbSprite, type ThumbCell } from '../../lib/image/thumbs'

interface IndexData {
  stage: 'empty' | 'edit'
  photo: string | null
  photoW: number
  photoH: number
  stageW: number
  stageH: number
  styles: ThumbCell[]
  spritePath: string
  spriteW: number
  activeStyle: string | null
  statusBar: number
  topbarPadRight: number
}

/** 选一张照片（拍照 / 相册）→ 临时文件路径。
 *  用户点取消时 reject（errMsg 形如「chooseMedia:fail cancel」）—— 调用方别当错误报。 */
export async function pickPhoto(source: 'camera' | 'album'): Promise<string> {
  const res = await wx.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sizeType: ['original'],
    sourceType: [source],
  })
  return res.tempFiles[0].tempFilePath
}

/** 照片区容器尺寸 + 画布节点（建管线用）。 */
interface StageBox {
  w: number
  h: number
  node: CanvasNode
}

/**
 * 一次问两样东西：照片区容器多大（算画布显示尺寸用）、画布节点在哪。
 *
 * ⚠️ 链式 API 的返回值必须**接住再 exec** —— 探针 2026-09 踩过：`q.node()` 单写
 * 一行、拿原来的 q 去 exec，那个查询根本不知道要取节点，画布全报「拿不到节点」。
 */
function queryStage(page: WechatMiniprogram.Page.TrivialInstance): Promise<StageBox> {
  return new Promise((ok, no) => {
    const q = wx.createSelectorQuery().in(page)
    const withArea = q.select('#stage-area').fields({ size: true })
    const withNode = withArea.select('#stage').fields({ node: true })
    withNode.exec(res => {
      const area = res && res[0]
      const node = res && res[1] && res[1].node
      if (area && area.width > 0 && node) ok({ w: area.width, h: area.height, node })
      else no(new Error('拿不到照片区的画布节点'))
    })
  })
}

/**
 * 把临时文件加载成**画布的 Image 对象**（`node.createImage()`）—— 管线只认它，
 * 不能直接把文件路径给它。等 onload 拿到宽高之后才算好。
 */
function loadImage(node: CanvasNode, src: string): Promise<WechatMiniprogram.Image> {
  return new Promise((ok, no) => {
    const img = node.createImage()
    img.onload = () => ok(img)
    img.onerror = () => no(new Error('这张照片加载不进画布'))
    img.src = src
  })
}

Page({
  data: {
    statusBar: 44,
    topbarPadRight: 16, // 首屏占位；onLoad 里按胶囊位置换真值（32rpx ≈ 375 宽下的 16px）
    stage: 'empty',
    photo: null,
    photoW: 0,
    photoH: 0,
    stageW: 0,
    stageH: 0,
    styles: [],
    spritePath: '',
    spriteW: 0,
    activeStyle: null,
  } as IndexData,

  // 非 data 的实例状态。`as` 是为了让推断出 `TonePipeline | null`（不然收窄成 null）。
  pipe: null as TonePipeline | null,
  /** 当前这套参数（点风格 = 整组赋值；说一句/滑杆那几个任务接下来也读它） */
  params: { ...ZERO } as Adjustments,

  onLoad() {
    // 状态栏高度给顶栏让位（navigationStyle 是 custom，页面自己画顶栏）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    // 微信右上角那颗胶囊画在我们页面**之上** —— 画面里量出来它正好整个压在「保存」上
    // （390 宽：胶囊 x=296~383，「保存」x=334~384）。让位量 = 屏幕右缘到胶囊左缘
    // + 一条和左边距（32rpx）同宽的缝；没有胶囊的环境就只用那条缝，两边对称。
    const gap = Math.round(32 * info.windowWidth / 750)
    let topbarPadRight = gap
    try {
      const menu = wx.getMenuButtonBoundingClientRect()
      if (menu && menu.left > 0) topbarPadRight = info.windowWidth - menu.left + gap
    } catch (e) { /* 没有胶囊的环境：右边和左边一样宽 */ }
    this.setData({ statusBar: info.statusBarHeight ?? 44, topbarPadRight })
  },

  async onCamera() { await this.loadFrom('camera') },
  async onAlbum() { await this.loadFrom('album') },

  /** 选照片 → 量尺寸 → 进编辑态（照片交给渲染管线画上屏）。取消不提示，真失败才给一句人话。 */
  async loadFrom(source: 'camera' | 'album') {
    try {
      const path = await pickPhoto(source)
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>(
        (ok, no) => wx.getImageInfo({ src: path, success: ok, fail: no }))
      // 先进编辑态（画布得在树上才能拿到节点），渲染接在 setData 落地之后。
      // 风格栏三个字段在这里**归零**：上一张照片的 sprite/点亮一律不许带过来
      // （新照片的 sprite 画好之前，条上宁可先空着，也不能挂旧照片的小图）。
      await new Promise<void>(ok => this.setData(
        {
          stage: 'edit', photo: path, photoW: info.width, photoH: info.height,
          styles: [], spritePath: '', spriteW: 0, activeStyle: null,
        }, ok))
      await this.startRender(path)
    } catch (e) {
      console.error('[index] 照片加载/渲染失败：', e)
      // 用户取消（errMsg 含 cancel）不是错，别的才提示
      if (!String((e as { errMsg?: string })?.errMsg).includes('cancel')) {
        wx.showToast({ title: '这张照片打不开，换一张试试', icon: 'none' })
      }
    }
  },

  /**
   * 把照片画上屏：拿节点 → 加载图片 → 建管线 → 上传 → 先出一张原图。
   *
   * ⚠️ 顺序上**先加载图片、后建管线**（和任务书草稿相反，理由如下）：建出管线之后
   * 这条路就再没有 await 了，从建出来到挂上 this.pipe、渲染完，一口气做完。
   * 否则「等图片加载」那段几百毫秒里用户点「换一张」，就会往已经拆掉的舞台上接着
   * 建东西（画布元素没了，管线却建出来了 —— 一根没人管的 GL 上下文）。
   */
  async startRender(path: string) {
    const box = await queryStage(this)
    if (this.data.stage !== 'edit') return // 等的这一会儿里用户点了「换一张」
    const img = await loadImage(box.node, path)
    if (this.data.stage !== 'edit') return // 加载图片是要等的，回来再核一次

    this.disposePipe() // 万一还挂着一根（正常路径里「换一张」那一步已经收掉了）
    const pipe = TonePipeline.fromCanvasNode(box.node)
    this.pipe = pipe
    try {
      pipe.setImage(img)
      pipe.resizeToImage() // 绘图缓冲 = 照片原尺寸（和电脑版一致）
      // 显示尺寸 = 照片**等比装进**照片区（和 `mode="aspectFit"`、电脑版 `.canvas`
      // 的 max-width/max-height 是同一条规矩）；小图不放大，最多 1:1。
      const k = Math.min(1, box.w / img.width, box.h / img.height)
      this.setData({ stageW: Math.round(img.width * k), stageH: Math.round(img.height * k) })
      this.params = { ...ZERO } // 新照片 = 什么都没调
      pipe.render(this.params) // 先出一张原图
    } catch (e) {
      this.disposePipe() // 半截的管线别留着（GL 上下文是有限资源）
      throw e
    }

    // 风格栏的十几张小图：借主画布画一遍再还回来（见 lib/image/thumbs.ts）。
    // ⚠️ **单独 catch**：缩略图画不出来只该让这一条空着，照片本身照常看
    //    （把主渲染带下水的话，用户连照片都没了）。
    try {
      const sprite = await renderThumbSprite(box.node, pipe, img, PRESETS, this.params)
      if (this.pipe !== pipe) return // 等的这一会儿里换了照片/收了工，这趟作废
      const last = sprite.cells[sprite.cells.length - 1]
      // 点亮 = 共享 activePresetId 算的（**全等**才亮、全零亮「原图」、都不等谁都不亮），
      // 不是"点了谁就亮谁"的死记 —— 等「说一句」能改参数了，这里不用再改判据。
      this.setData({
        spritePath: sprite.path,
        spriteW: last.x + last.w,
        styles: sprite.cells,
        activeStyle: activePresetId(this.params, false),
      })
    } catch (e) {
      console.error('[index] 风格栏的缩略图没画出来（照片本身不受影响）：', e)
    }
  },

  /** 收掉当前管线（「换一张」和重进编辑态前都走这条）。 */
  disposePipe() {
    if (this.pipe) this.pipe.dispose()
    this.pipe = null
  },

  onPickAgain() {
    this.disposePipe()
    this.setData({ stage: 'empty', photo: null, photoW: 0, photoH: 0, stageW: 0, stageH: 0 })
  },

  /**
   * 点一格风格：参数**整组赋值** → 重画一帧（秒变）→ 按共享判据点亮。
   *
   * 「原图」不是预设：它 = 参数全零（`ORIGINAL_ID` 那一格，见共享 presets.ts）。
   *
   * 点亮走 `activePresetId(参数, 无滤镜)` —— 和电脑版**同一份**契约：
   * **全等**才亮、全零亮「原图」、都不等谁都不亮（不搞"接近"）。这里每次点完
   * 都是拿"刚赋进去的那一套"现算，所以点谁亮谁是结果、不是承诺。
   * v1 没有滤镜，第二个参数恒 false；Lut 来了要在这里和 thumbs 两边一起看。
   */
  onStyleTap(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id)
    const preset = PRESETS.find(p => p.id === id)
    const next: Adjustments | undefined = id === ORIGINAL_ID ? ZERO : preset?.adjustments
    const pipe = this.pipe
    if (!next || !pipe) return
    this.params = { ...next } // 存副本：预设那份是模块级常量，谁都不许原地改
    pipe.render(this.params)
    this.setData({ activeStyle: activePresetId(this.params, false) })
  },

  onSave() {}, // 任务 9
})
