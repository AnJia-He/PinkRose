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
//   dev —— 是不是「开发版」（wx.getAccountInfoSync().envVersion === 'develop'）：
//          冒烟用的「载入测试照片」按钮只在这一态显示（体验版/正式版不给）
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
  dev: boolean
  statusBar: number
  topbarPadRight: number
}

/**
 * 冒烟用的测试照片（★ Task 7）——**打进包的资源路径**，不走系统选图弹窗。
 * dev 按钮（只开发版可见）把这条路径喂给 `applyPickedPhoto`，后面的路和
 * 「从相册选」完全同一条。
 *
 * ⚠️ 它就在包里 —— **别给它加 packOptions.ignore**（2026-10-12 实测那条连本地
 * 模拟器编译也一起生效，冒烟会因读不到图而红；不 ignore 也没事，整个包 334KB，
 * 离 2MB 主包上限远得很）。见 mini/README.md「冒烟 + 全黑哨兵」。
 */
const DEV_PHOTO = '/assets/test-photo.jpg'

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
    dev: false,
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
    // 仅开发版显示冒烟用的测试通道（裁定 3：不建独立 dev 页 —— 哨兵要在真实渲染
    // 路径上跑）。envVersion：develop = 开发版 / trial = 体验版 / release = 正式版。
    // ⚠️ 拿不到账号信息（个别环境会抛）就当不是开发版 —— 宁可没按钮，不能崩在 onLoad。
    let dev = false
    try { dev = wx.getAccountInfoSync().miniProgram.envVersion === 'develop' } catch (e) { /* 见上 */ }
    this.setData({ statusBar: info.statusBarHeight ?? 44, topbarPadRight, dev })
  },

  async onCamera() { await this.loadFrom('camera') },
  async onAlbum() { await this.loadFrom('album') },

  /** ★ Task 7：dev 通道（wxml 里 wx:if="{{dev}}" 只给开发版）——把**打进包**的测试
   *  照片喂进同一条「选完照片」的路，绕开系统选图弹窗（自动化冒烟用）。 */
  async onDevPhoto() {
    try {
      await this.applyPickedPhoto(DEV_PHOTO)
    } catch (e) {
      this.reportPhotoFailure(e)
    }
  },

  /** 选照片 → 临时文件路径 → 交给 applyPickedPhoto。取消不提示，真失败才给一句人话。 */
  async loadFrom(source: 'camera' | 'album') {
    try {
      await this.applyPickedPhoto(await pickPhoto(source))
    } catch (e) {
      this.reportPhotoFailure(e)
    }
  },

  /**
   * 「已经拿到一张照片路径」之后的那一段 —— **选图两条路和 dev 通道共用这一份**
   * （别各写一份）：量尺寸 → 进编辑态 → 渲染上屏。出错往上抛，提示归调用方。
   */
  async applyPickedPhoto(path: string) {
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
  },

  /** 照片没走通的统一出口：用户取消（errMsg 含 cancel）不是错，别的才提示一句人话。
   *  ⚠️ 消息**拼成字符串**再打一份：automator 的控制台桥把 Error 对象压成 `{}`
   *     （键不可枚举）—— 冒烟失败时要靠这行看见「为什么」（比如着色器编译失败）。 */
  reportPhotoFailure(e: unknown) {
    const detail = e && (e as Error).message ? ' ' + (e as Error).message : ''
    console.error('[index] 照片加载/渲染失败：' + detail, e)
    if (!String((e as { errMsg?: string })?.errMsg).includes('cancel')) {
      wx.showToast({ title: '这张照片打不开，换一张试试', icon: 'none' })
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

  /**
   * ★ 冒烟/自动化专用（Task 7）——「全黑哨兵」的探针。**纯读、同步、立即返回**
   * （automator 侧一次 callMethod 就拿走），返回 `{ colors, first, err }`。
   *
   * 为什么要有它：**GLSL 编不过 = 每张照片全黑**，而 typecheck / 构建 / 单测
   * 四样全瞎（电脑版 2026-10-05 真机抓到过一次，来路写在 src/render/shader.ts
   * 顶上）。只有真渲染 + 读像素数颜色，才抓得到这一类静默全黑。
   *
   *   colors —— 16×16 网格采样的**不同颜色数**：真实照片是几百；全黑 / 全白 /
   *             空画布 = 1；根本没建起管线（比如着色器编译失败）时给 0。
   *   first  —— 第一个采样点的 "r,g,b"（画面左下角附近，GL 行序自下而上）：
   *             用来比「相邻两档画的到底是不是同一张」。
   *   err    —— gl.getError()：0 = 干净；没有管线时给 -1；readPixels 抛错给 -2。
   *             ⚠️ getError 读一次**清一次账**，一个画面别读两回（第二回恒 0）。
   *
   * ⚠️ 数颜色**不需要翻行**（行序只影响读出来的先后，不影响"数出来是几种"）；
   *    翻行只在把像素交给 putImageData 时要（见 lib/image/thumbs.ts 的画法）。
   * ⚠️ 采样而不是全量数像素：照片 1080×2048 是 220 万像素，全量数又慢又占内存；
   *    网格采样足够判"是不是纯色"这一件事。
   */
  __probeColors(): { colors: number; first: string; err: number } {
    const pipe = this.pipe
    if (!pipe) return { colors: 0, first: '', err: -1 }
    let px: Uint8Array
    try {
      px = pipe.readPixels()
    } catch (e) {
      console.error('[index] 冒烟探针：readPixels 失败：', e)
      return { colors: 0, first: '', err: -2 }
    }
    const N = 16
    const w = this.data.photoW
    const h = this.data.photoH
    const seen: { [k: string]: true } = {}
    let first = ''
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = Math.floor((i + 0.5) * w / N)
        const y = Math.floor((j + 0.5) * h / N)
        const o = (y * w + x) * 4
        const k = px[o] + ',' + px[o + 1] + ',' + px[o + 2]
        seen[k] = true
        if (!first) first = k
      }
    }
    return { colors: Object.keys(seen).length, first, err: pipe.getError() }
  },

  onSave() {}, // 任务 9
})
