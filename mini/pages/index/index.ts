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
//
// ★ Task 12（说一句）新增的一簇：
//   sayText —— 输入条里的字（受控值）
//   sayBusy / sayBusyText —— 输入条的忙态（忙碌期间输入框换成一句话，不再收字）：
//                            路由那 1.3~1.6 秒显示「在想…」（spec §4.2：这段不弹蒙层）；
//                            生成期间显示「正在修…」（秒数在蒙层上，这条不跟秒）
//   sayBubble —— 输入条上方那条浮条的字（'' = 收着不显示）；5 秒后自动淡出
//   generating / genText / genSeconds —— 生成中蒙层（暗化 + 转圈 + 秒表文案 + 停止）。
//                genText 是**算好的整句**（页面里唯一的文案口径，冒烟按它断言）；
//                5 秒内不带秒数（电脑版契约），之后「正在修…已经等了 N 秒」
//   canUndo —— 照片右下角「撤销」亮不亮（一次生成 = 一层，只对生成有意义）
import { applyDeltas, ZERO, type Adjustments } from '../../lib/shared/adjustments'
import { activePresetId, ORIGINAL_ID, PRESETS } from '../../lib/shared/presets'
import { TonePipeline, type CanvasNode } from '../../lib/gl/tonePipeline'
import { renderThumbSprite, type ThumbCell } from '../../lib/image/thumbs'
import { exportPhoto, saveToAlbum } from '../../lib/image/export'
import { ApiError, apiPost, isAbortError, setApiBaseOverride } from '../../lib/api'
import { getToken } from '../../lib/auth'
import { prepareForModel, prepareForRouting } from '../../lib/image/prepare'

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
  // ── ★ Task 12（说一句）──────────────────────────────────────────────
  sayText: string
  sayBusy: boolean
  sayBusyText: string
  sayBubble: string
  generating: boolean
  genText: string
  genSeconds: number
  canUndo: boolean
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

/**
 * 「按住看原图」要按满这么久才算数（毫秒）—— **电脑版同款契约**
 * （`src/ui/Canvas.tsx` 的 `PEEK_HOLD_MS`）。
 * ⚠️ 不能改成"一按就出"：那样手一碰照片（比如滑风格栏时蹭到、以后加拖动平移）
 * 画面都会先闪一下没调过色的原图。电脑版为此定的是 150ms，两边一个字不差。
 */
const PEEK_HOLD_MS = 150

/**
 * 手指挪动**超过这么多像素**才算"在拖动"（手抖不算）—— 和电脑版 `DRAG_MIN_PX` 同值。
 * 拖动的活（缩放平移）是以后的事，现在这一下只做一件事：**取消"按住看原图"**。
 * ⚠️ 要这个容差：真机上按住不动也会报几像素的 touchmove，没它的话原图根本按不出来
 * （按住看原图直接变成"看运气"）。
 */
const MOVE_CANCEL_PX = 5

/** 浮条停留时长（毫秒）—— spec §4.2「几秒后淡出」；5 秒是电脑版忙文案换挡用的坎，
 *  这里取它当"一眼看得完"的量。 */
const BUBBLE_MS = 5000

/**
 * 生成那条路的 `wx.request` 超时（毫秒）—— **不吃平台默认的 60 秒**（Task 11 审查
 * 留给 Task 12 评估的那条）。理由（完整版在 `lib/api.ts` 的 PostOptions 注释）：
 * `/api/edit` 在服务端要过**全局串行队列**，一次商汤编辑本身 4~8.5 秒、上游自己的
 * 超时是 180 秒 —— 队列里前头还排着的时候，60 秒会被**正常但排队久**的请求撞上，
 * 而那个失败会被 api 层译成「连不上服务器」（假话：网好着，是等得久）。
 * 120 秒 = 上游 180 秒里我们这边肯等的下限，比它再小就又可能误杀正常请求。
 */
const EDIT_TIMEOUT_MS = 120000

/** 生成结果的落盘槽（ping-pong，见 `writeGenImage`）：写"当前没在显示"的那个，
 *  撤销要还原的那张文件绝不会被覆盖。 */
const GEN_SLOT_0 = 'pr-gen-0.jpg'
const GEN_SLOT_1 = 'pr-gen-1.jpg'

/** 秒表换挡点（秒）—— 电脑版契约：**5 秒内不显示秒数**（`busyText` 同款）。
 *  ⚠️ 修的时候别动这个数：那是"提前看到秒数"和"永远看不到秒数"的分界。 */
const GEN_SECONDS_AFTER = 5

/** 秒表重算间隔（毫秒）：250ms 一跳，但**文案变了才 setData**（一秒只渲一次）。
 *  用 1000ms 整数跳会偶尔跳秒（定时器漂移 —— 电脑版评论里记过同款）。 */
const GEN_TICK_MS = 250

/**
 * `/api/route` 回来的决策 —— 字段名以 `shared/protocol.ts` 的 `RouteDecision` 为准
 * （那份**没同步进小程序**，见 sync-mini-shared.mjs 的 FILES 表；这里只收读者要用的）。
 * ⚠️ `lut` / `preset` 在协议里是**必填**字段，小程序第一版两样都没有（没有用户滤镜 /
 * 用户预设那两块界面）—— 收下即弃，真后端给了非 null 会留一行警告（别静默）。
 */
interface RouteDecision {
  route: 'params' | 'generate' | 'both'
  /** 参数**增量**（缺的键按 0 算，叠加交给共享 applyDeltas —— LLM 不做算术） */
  paramDeltas: Partial<Adjustments>
  reply: string
  editPrompt: string
  needsDisambiguation: boolean
  degraded: boolean
  lut: unknown
  preset: unknown
}

/** `POST /api/edit` 的回体（`shared/protocol.ts` 的 EditResponse，字段名一字不改）。 */
interface EditResult {
  imageDataUrl: string
  width: number
  height: number
}

/**
 * 「撤销」要还原的现场（spec §4.3：**回生成前的画面和参数**）。
 * ⚠️ 在**发送那一刻**就拍好 —— 'both' 那条参数先落地，等生成开始再拍就拍到
 * "落过参数"的了（撤销还原不回去）。生成**成功**那刻才写进 `undoSnap`。
 */
interface UndoSnap {
  photo: string
  params: Adjustments
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

/** `__probeExport` 的回报形状（只有探针读它，见那个方法和 `probeExport` 字段）。 */
interface ExportProbe {
  state: 'running' | 'ok' | 'fail'
  /** 走的那条路（export.ts 的 ExportVia） */
  via?: string
  path?: string
  why?: string
  ms?: number
}

/** `__probeLogin` / `__probeMe` 的回报形状（Task 11；异步结果同样靠实例字段带出去）。 */
interface NetProbe {
  state: 'running' | 'ok' | 'fail'
  /** 拿到票时只报**长度** —— ★ 票本身绝不 print（探针日志要贴进报告）。 */
  tokenLen?: number
  /** 失败时：能直接给人看的那句话（Thrown 的 message 就是那个口径，见 lib/api.ts）。 */
  message?: string
  /** ApiError 才有：服务端错误码 + HTTP 状态码（认 503「没配」和 401「重登」用）。 */
  code?: string
  status?: number | null
  ms?: number
}

/**
 * `__probePrepare` 的回报形状（Task 11：缩图数字）。
 * ⚠️ dataURL 本身**不进这里** —— 一条路由 dataURL 就几十 KB、送模型的几百 KB，
 * 搬过 automator 又慢又没意义。它俩另放两个实例字段，探针在**页面里**现解
 * JPEG 头拿真实尺寸（见 `.superpowers/mini/task11-probe.cjs`）。
 */
interface PrepareProbe {
  state: 'running' | 'ok' | 'fail'
  why?: string
  /** 源照片尺寸（wx.getImageInfo 量的） */
  srcW?: number
  srcH?: number
  /** 路由小图：dataURL 长度 / dataURL 前 23 个字（前缀断言用）/ 耗时 */
  routeLen?: number
  routePrefix?: string
  routeMs?: number
  /** 送模型的正图：函数返回的目标尺寸 / 耗时（真实文件尺寸由探针解 JPEG 头核） */
  modelW?: number
  modelH?: number
  modelMs?: number
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
    sayText: '',
    sayBusy: false,
    sayBusyText: '',
    sayBubble: '',
    generating: false,
    genText: '',
    genSeconds: 0,
    canUndo: false,
  } as IndexData,

  // 非 data 的实例状态。`as` 是为了让推断出 `TonePipeline | null`（不然收窄成 null）。
  pipe: null as TonePipeline | null,
  /** 画布节点（★ Task 9：保存导出要用 —— `wx.canvasToTempFilePath` 认的是节点，不是管线）。
   *  和 `pipe` 同生同死：startRender 里一起挂上、disposePipe 里一起清掉。 */
  node: null as CanvasNode | null,
  /** 当前这套参数（点风格 = 整组赋值；说一句/滑杆那几个任务接下来也读它） */
  params: { ...ZERO } as Adjustments,
  /** ★ Task 9：保存进行中（只防重入，不参与渲染 —— 所以放实例字段、不进 data）。
   *  点了「保存」到导出+存盘走完之前，再点多少次都被这一条忽略。 */
  saving: false,
  /** ★ 探针专用（Task 9）：上一趟 `__probeExport` 的结果（异步结果没法用 callMethod
   *  直接拿，探针轮询 `getCurrentPages()` 里的这个字段 —— 同 task8 读 peekStart 那招）。
   *  生产路径**没人读它**。 */
  probeExport: null as ExportProbe | null,
  /** ★ 探针专用（Task 11）：`__probeLogin` / `__probeMe` / `__probePrepare` 的上一趟
   *  结果（同 probeExport 那招）。生产路径**没人读它们**。 */
  probeLogin: null as NetProbe | null,
  probeMe: null as NetProbe | null,
  probePrepare: null as PrepareProbe | null,
  /** ★ 探针专用（Task 11）：两条缩图的 dataURL 原件（几十 KB～几百 KB，别搬过
   *  automator）—— 探针在页面里解析 JPEG 头，只把小尺寸拿回去。 */
  prepRouteDataUrl: '',
  prepModelDataUrl: '',
  /** 「按住看原图」的计时器（null = 没在按）。到点之前谁动一下就清掉。 */
  peekTimer: null as number | null,
  /** 现在画面上画的是不是**原图**（按住看原图进行中）。 */
  peeking: false,
  /** 这次按下的起点（手指挪没挪动，按它判，见 MOVE_CANCEL_PX）。 */
  peekStart: { x: 0, y: 0 },

  /** ★ Task 12：浮条 5 秒淡出的计时器（null = 没有浮条在屏上）。 */
  bubbleTimer: null as number | null,
  /**
   * ★ Task 12：这一次生成的「停止」把手。**一个对象、不是单个 task**：
   * 「停止」可能按在 task 交出来**之前**（缩图那一两百毫秒里）—— 那时先记
   * `aborted`，`onTask` 到的时候补掐（见 onStopGen / runGenerate 的 opts.onTask）。
   * `aborted` 也让 catch 分得清"人叫停的"和"真失败"。
   */
  genAbort: { task: null, aborted: false } as {
    task: WechatMiniprogram.RequestTask | null
    aborted: boolean
  },
  /** ★ Task 12：蒙层秒表（genStartedAt = 出发时刻，文案变了才 setData）。 */
  genTickTimer: null as number | null,
  genStartedAt: 0,
  /**
   * ★ Task 12：照片的代数 —— **换照片 / 撤销 / 生成落图**都 +1。所有异步的"回来"
   * （路由决策、生成结果）落地前都拿出发时抄的号对一遍，对不上就是"画面已经变了"，
   * 结果作废只留一句通报 —— 电脑版 `baseSeqRef` 的同类（那边追过串会话那个大坑）。
   */
  genPhotoSeq: 0,
  /** ★ Task 12：「撤销」还原的现场（见 UndoSnap）。生成**成功**那刻才写；撤销消费掉。 */
  undoSnap: null as UndoSnap | null,

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
    // ★ Task 12：照片要换了 —— 在飞的生成/路由/浮条/撤销从这一刻起全部翻篇：
    // 生成掐掉（那一趟回来也一定作废，顺手让服务端也停），旧照片的撤销和浮条清掉。
    // ⚠️ 代数 **+1 要赶在 setData 之前**（同步）—— setData 的落地要等一个来回，
    //    在飞的那趟生成万一在这个缝里回来，看到的就是"画面已经变了"该有的样子。
    this.abortGenInFlight()
    this.clearBubble()
    this.undoSnap = null
    this.genPhotoSeq++
    // 先进编辑态（画布得在树上才能拿到节点），渲染接在 setData 落地之后。
    // 风格栏三个字段在这里**归零**：上一张照片的 sprite/点亮一律不许带过来
    // （新照片的 sprite 画好之前，条上宁可先空着，也不能挂旧照片的小图）。
    await new Promise<void>(ok => this.setData(
      {
        stage: 'edit', photo: path, photoW: info.width, photoH: info.height,
        styles: [], spritePath: '', spriteW: 0, activeStyle: null, canUndo: false,
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
    this.node = box.node // 保存导出要用（和 pipe 同生同死，disposePipe 一起清）
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

  /** 收掉当前管线（「换一张」和重进编辑态前都走这条）。
   *  ★ 顺手把「按住看原图」的状态归零（**管线都没了，这个手势自然结束**）。
   *  ⚠️ 这两行是**保险、不是修 bug**（写清楚，别让下一个人当它是承重墙）：今天不收
   *  也不会崩、不会卡死 —— 到点的定时器会撞上 `this.pipe` 是 null 直接早退，残留的
   *  `peeking` 也会在下一次抬手/下一次按住时被纠正。收它的理由只有一条：
   *  **`peeking` 必须始终等于"屏幕此刻画的是原图"**，不许它对新照片撒谎
   *  （今天没人拿它当判据，它只决定 endPeek 要不要补画一帧；以后拖动/缩放真拿它
   *  当判据时，撒谎的代价就不止是白画一帧了）。 */
  disposePipe() {
    this.stopPeekTimer()
    this.peeking = false
    if (this.pipe) this.pipe.dispose()
    this.pipe = null
    this.node = null // 和 pipe 同生同死（保存导出要用它，见 node 字段的注释）
  },

  onPickAgain() {
    this.disposePipe()
    // ★ Task 12：回空态 = 一切归零 —— 在飞的生成掐掉、浮条收掉、撤销作废、
    // 代数 +1（在飞的"回来"看到它就知道画面没了）。
    this.abortGenInFlight()
    this.clearBubble()
    this.undoSnap = null
    this.genPhotoSeq++
    this.setData({
      stage: 'empty', photo: null, photoW: 0, photoH: 0, stageW: 0, stageH: 0,
      canUndo: false, sayBusy: false, generating: false,
    })
  },

  /**
   * ★ Task 8 · 按住看原图（照片区四个触摸事件在 wxml 上接线）。
   *
   * 契约（电脑版同款，见 `PEEK_HOLD_MS`）：按住 **150ms** 到点，画面才切成
   * **原图**（= 全零参数画一帧，底图没套任何参数的样子）；抬手 → 用**当前参数**
   * 画回来。**快速点一下（不到 150ms）什么都不发生** —— 不能"一按就出"。
   *
   * ⚠️ 三个"松手"出口（`touchend` / `touchcancel` / 挪动出去）**少接一个**，
   * 用户就会被**永久留在原图上**，而他没有任何办法按回来（电脑版同一课）。
   */
  onPhotoTouchStart(e: WechatMiniprogram.TouchEvent) {
    if (!this.pipe) return
    // ⚠️ `e &&` 两道：automator 探针用 `page.callMethod('onPhotoTouchStart')` 直接调
    //    这个处理器时**没有事件对象**（冒烟那条备选路），别在那儿抛。
    const t = e && e.touches && e.touches[0]
    this.peekStart = { x: t ? t.clientX : 0, y: t ? t.clientY : 0 }
    this.stopPeekTimer() // 上一次没清干净（第二根手指、上次 touchend 没送到）先收掉
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null
      const pipe = this.pipe
      if (!pipe) return // 等的这一会儿里管线没了（换照片），没什么可看的
      this.peeking = true
      // 看原图 = 全零参数画一帧。⚠️ `this.params` **一个字不动** —— 它始终是
      // "用户当前挑的那套"，抬手要照着它画回来。（v1 还没有 Lut，第二个参数默认 0）
      pipe.render(ZERO)
    }, PEEK_HOLD_MS)
  },

  onPhotoTouchEnd() { this.endPeek() },
  onPhotoTouchCancel() { this.endPeek() },

  /** 手指挪动：小抖动（`MOVE_CANCEL_PX` 之内）不算，挪出去了就不叫"按住"了 —— 取消。 */
  onPhotoTouchMove(e: WechatMiniprogram.TouchEvent) {
    const t = e && e.touches && e.touches[0] // 同上：探针直接调处理器时没有事件对象
    if (!t) return this.endPeek() // 触点是空的（系统收走的怪状态）：按"收场"处理
    const dx = t.clientX - this.peekStart.x
    const dy = t.clientY - this.peekStart.y
    if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) this.endPeek()
  },

  /** 按住看原图的收场（三个松手出口共用这一份，幂等）：清计时器 + 正在看原图就
   *  用**当前参数**画回来。 */
  endPeek() {
    const wasPeeking = this.peeking
    this.stopPeekTimer()
    this.peeking = false
    if (wasPeeking && this.pipe) this.pipe.render(this.params)
  },

  stopPeekTimer() {
    if (this.peekTimer !== null) {
      clearTimeout(this.peekTimer)
      this.peekTimer = null
    }
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

  // ── ★ Task 12 · 说一句（输入 → 路由 → 分流 → 蒙层/停止 → 换图/撤销）─────────

  /** 输入条打字（受控值）。 */
  onSayInput(e: WechatMiniprogram.Input) {
    this.setData({ sayText: e.detail.value })
  },

  /**
   * 按下发送箭头 / 键盘上的发送键 —— 「说一句」的起点。
   *
   * 顺序（和电脑版 App.tsx 的 `send` 同一条流水）：**先挂号**（sayBusy = 输入条换成
   * 「在想…」，这 1.3~1.6 秒不弹蒙层，spec §4.2）→ 640 缩图 → `/api/route`（带当前
   * 15 参数当上下文）→ 决策回来先过一道**代数闸门**（等这一会儿里换了照片/撤销了，
   * 决策作废、一个字不动 —— 电脑版同款守卫与话术）→ applyDecision 分流。
   */
  async onSaySend() {
    if (this.data.sayBusy || this.data.generating) return // 上一句还没算完
    const text = (this.data.sayText || '').trim()
    if (!text) return // 空话不发（键盘的发送键也会走到这儿）
    const pipe = this.pipe
    const photo = this.data.photo
    if (!pipe || !photo) return
    // ★ 撤销的现场**在发送这一刻**拍好（'both' 那条参数马上要落地，晚了就拍到
    //   "落过参数"的了）—— 但只在生成**成功**那刻才写进 undoSnap（见 runGenerate）。
    const snap: UndoSnap = { photo, params: { ...this.params } }
    const seqAtStart = this.genPhotoSeq
    this.setData({ sayText: '', sayBusy: true, sayBusyText: '在想…' })
    let decision: RouteDecision
    try {
      // 路由看的是**用户此刻看到的画面**（640 小图；这条故意不做 align32，见 prepare.ts）
      const small = await prepareForRouting(photo, this.data.photoW, this.data.photoH)
      const res = await apiPost<{ decision: RouteDecision }>('/api/route', {
        imageDataUrl: small, text, params: { ...this.params },
      })
      decision = res.decision
    } catch (e) {
      console.error('[index] 路由没走通：', e)
      this.setData({ sayBusy: false })
      // ★ Task 12 审查 Minor：失败也查代数 —— 等这一会儿里换了照片 / 回空态，这句
      // 失败只该烂在控制台里，别挂到新照片的浮条上（同下面成功路径那道闸门的处置）。
      if (this.genPhotoSeq !== seqAtStart || this.pipe !== pipe) {
        console.error('[index] 路由失败回来时画面已经变了，这一趟丢掉（这句不提）')
        return
      }
      // ApiError 的 message 就是能直接给人看的话（lib/api.ts 的文件头）；
      // 兜底那句和电脑版路由失败一字不差。
      this.showBubble(e instanceof ApiError ? e.message : '出了点问题，再试一次？')
      return
    }
    // 等这 1.3~1.6 秒里画面变了（换了照片 / 撤销了）：决策作废，一个字不动。
    // 话术照电脑版 —— 不说"没听懂"（问题不在那句话），说清"这边没动它、可以再说一遍"。
    if (this.genPhotoSeq !== seqAtStart || this.pipe !== pipe) {
      console.error('[index] 决策回来时画面已经变了，这一趟丢掉（钱没花，参数也没动）')
      this.setData({ sayBusy: false })
      if (this.data.stage === 'edit') {
        this.showBubble('刚才那句话还没算完，画面已经变了 —— 这边没动它。要的话，再说一遍。')
      }
      return
    }
    await this.applyDecision(decision, snap)
  },

  /**
   * 决策落地 —— 分流三条（契约照电脑版 `useGeneration.ts` 的 applyDecision，那边是权威）：
   *
   *   · params / both：参数那半**本地立刻生效**（叠加 + 钳制交给共享 applyDeltas，
   *     模型只负责"大概要多少"）；点亮沿用共享 activePresetId（全等才亮）。
   *   · needsDisambiguation：参数照收（免费可逆），**生成拦住**（电脑版 §6.3）——
   *     小程序第一版没有"在图上点一下"那条路，话术尾巴改成"换个说法"（不许承诺点选）。
   *   · degraded：拼上电脑版一字不差的提醒（只拼给**生成**那两条 —— 纯参数免费可逆，
   *     不值当报一次警）。
   *   · generate / both：进 runGenerate（蒙层 → … → 换图 + 撤销）。
   */
  async applyDecision(d: RouteDecision, snap: UndoSnap) {
    const isParams = d.route === 'params' || d.route === 'both'
    if (isParams) {
      this.params = applyDeltas(this.params, d.paramDeltas || {})
      const pipe = this.pipe
      if (pipe) pipe.render(this.params)
      // 点亮 = 共享判据算的（和点风格那条同一个函数、同一条规矩：全等才亮）
      this.setData({ activeStyle: activePresetId(this.params, false) })
    }
    // lut / preset 在协议里必填，但小程序第一版还没有那两块（没有用户滤镜/预设）——
    // 收下即弃。真后端给了非 null 时留一行警告，别静默。
    if (d.lut || d.preset) {
      console.warn('[index] 决策带了 lut/preset —— 小程序第一版还没这两样，忽略了')
    }
    if (d.needsDisambiguation) {
      this.setData({ sayBusy: false })
      this.showBubble((d.reply || '好了。') + '我不太确定你指的是哪个 —— 换个说法再试试。')
      return
    }
    const isGen = d.route === 'generate' || d.route === 'both'
    const replyText = d.degraded && isGen
      ? (d.reply || '好了。') + '这次我拿不太准，不对的话换个说法再试试。'
      : (d.reply || '好了。')
    // 纯参数 / 不生成（含"模型声明 generate 却没给 editPrompt"的退化）：话说、不动手。
    // ⚠️ 退化那条必须落在这里 —— 进 runGenerate 会撞上开头的空 prompt 闸门，一声不吭。
    if (!isGen || !d.editPrompt) {
      this.setData({ sayBusy: false })
      this.showBubble(replyText)
      return
    }
    await this.runGenerate(d.editPrompt, replyText, snap)
  },

  /**
   * 生成那半：蒙层（暗化 + 转圈 + 秒表 + 停止）→ 新图落盘 → 换图 + 一句 reply + 撤销。
   *
   * @param reply 成功那一刻**和图片一起**说的话（电脑版契约：不在出发时先承诺）
   * @param snap 出发时拍好的「撤销」现场（见 UndoSnap —— 别在这里拍）
   */
  async runGenerate(editPrompt: string, reply: string, snap: UndoSnap) {
    const pipe = this.pipe
    const node = this.node
    const photo = this.data.photo
    if (!pipe || !node || !photo || !editPrompt) {
      // 正常路径进不来（出发前都核过）——真进来了就收掉忙态，别把「在想…」干挂着
      this.setData({ sayBusy: false })
      return
    }
    this.endPeek() // 万一有人正按着照片（长按看原图）—— 要换画面了，先把那笔收掉
    // ★ 这一趟的"我还在不在"：代数没动 + 还是那根管线。写完文件、加载完图之后
    //   **一次性同步上屏**（这中间不许再有 await，同 startRender 那条纪律）。
    const seqAtStart = this.genPhotoSeq
    const gone = () => this.genPhotoSeq !== seqAtStart || this.pipe !== pipe
    // 「停止」的把手：一个对象（见 genAbort 字段注释）+ 这一趟的身份令牌
    // （finally 里别把**下一次**生成的忙态/秒表清掉）。
    const abort = { task: null as WechatMiniprogram.RequestTask | null, aborted: false }
    this.genAbort = abort
    this.setData({ sayBusy: true, sayBusyText: '正在修…', generating: true, genText: '正在修…', genSeconds: 0 })
    this.startGenTicker()
    try {
      // 送模型的是**当前底图**（2048 + align32 的缩图），不是屏幕那张带效果的画面（铁律）
      const prepared = await prepareForModel(photo, this.data.photoW, this.data.photoH)
      const out = await apiPost<EditResult>('/api/edit', {
        imageDataUrl: prepared.dataUrl,
        editPrompt,
        width: prepared.width,
        height: prepared.height,
      }, {
        // 生成这条路显式给 120 秒（理由见 EDIT_TIMEOUT_MS / api.ts 的 PostOptions）
        timeoutMs: EDIT_TIMEOUT_MS,
        onTask: task => {
          // 「停止」可能按在 task 交出来**之前**（缩图那一两百毫秒里）：补掐
          if (abort.aborted) task.abort()
          else abort.task = task
        },
      })
      if (gone()) return this.dropLateGen()
      const path = await this.writeGenImage(out.imageDataUrl)
      if (gone()) return this.dropLateGen()
      const img = await loadImage(node, path)
      if (gone()) return this.dropLateGen()
      const box = await queryStage(this)
      if (gone()) return this.dropLateGen()
      // ↓ 从这里往下**全是同步的**（没有 await，画面不会被别的东西拆台）
      // 尺寸以**实际拿到的像素**为准（img.width/height），声明只当报警依据 —— 同电脑版
      if (img.width !== out.width || img.height !== out.height) {
        console.warn('[index] 生成回图尺寸与声明不符：声明 ' + out.width + 'x' + out.height +
          '，实际 ' + img.width + 'x' + img.height + '（以实际为准，不拉伸）')
      }
      pipe.setImage(img)
      pipe.resizeToImage()
      const k = Math.min(1, box.w / img.width, box.h / img.height)
      this.genPhotoSeq++ // 从这一刻起这张就是"当前"（在飞的旧任务全作废）
      this.setData({
        photo: path, photoW: img.width, photoH: img.height,
        stageW: Math.round(img.width * k), stageH: Math.round(img.height * k),
        canUndo: true,
      })
      this.undoSnap = snap
      pipe.render(this.params) // 参数原封不动继续生效（铁律：生成只换底图）
      this.showBubble(reply)
    } catch (e) {
      if (isAbortError(e)) {
        if (this.genPhotoSeq !== seqAtStart) {
          // 是**换照片**顺手掐的（见 abortGenInFlight）—— 画面都换了，这一趟不出声，
          // 更不许把「停了。」挂到新照片头上
          console.info('[index] 换照片时掐掉了在飞的生成，这一趟不作声')
        } else {
          // 人按的「停止」——不是失败：只说一句收尾（电脑版一字不差），
          // 画面和参数**一个字没动过**（也正因此不许说"没修成功"）
          this.showBubble('停了。')
        }
      } else if (gone()) {
        // ★ Task 12 审查 Minor：画面已经翻篇（换了照片 / 撤销了）时，迟到的失败
        // 只留控制台 —— 别把「没修成功」挂到新照片的浮条上（同上面 abort 分支的闸）。
        console.error('[index] 生成失败回来时画面已经变了，这一句不提：', e)
      } else {
        console.error('[index] 生成没走通：', e)
        this.showBubble(e instanceof ApiError ? e.message : '这次没修成功，再试一次？')
      }
    } finally {
      // 只收拾**我这一趟**的东西 —— 别把下一次生成的忙态/秒表清掉（换照片掐断
      // 之后用户可能已经又发了一句，旧这趟的收尾才姗姗来迟）。
      if (this.genAbort === abort) {
        this.genAbort = { task: null, aborted: false }
        this.stopGenTicker()
        this.setData({ generating: false, sayBusy: false })
      }
    }
  },

  /** 生成回来时画面已经变了：结果作废。钱花了，但写进别的画面更坏 —— 电脑版同款
   *  通报（留痕 + 说清"没写进去、可以再说一遍"）。 */
  dropLateGen() {
    console.error('[index] 生成回来时画面已经变了（换照片 / 撤销），这一版不写进去')
    if (this.data.stage === 'edit') {
      this.showBubble('刚才那次生成回来时，画面已经变了 —— 结果没写进去。要的话，再说一遍。')
    }
  },

  /**
   * 生成回来的 dataURL → **用户数据目录里的一张文件**（画布的 `img.src` 认文件路径
   * 最稳；dataURL 直接喂不保证认）。
   *
   * ★ 两个槽 ping-pong：写"当前没在显示"的那个 —— 撤销要还原的那张文件
   * （`snap.photo`，出发时拍的就是当时的当前）**绝不会被覆盖**。当前是槽 0 就写槽 1，
   * 反之亦然；原图（选来的临时路径）不在槽里，更碰不到。
   */
  writeGenImage(dataUrl: string): Promise<string> {
    const comma = dataUrl.indexOf(',')
    if (!dataUrl.startsWith('data:image/') || comma < 0) {
      console.error('[index] 生成结果不是图片 dataURL：' + String(dataUrl).slice(0, 40))
      return Promise.reject(new Error('生成的图存不下来，再试一次？'))
    }
    const slot = (this.data.photo || '').indexOf(GEN_SLOT_0) >= 0 ? GEN_SLOT_1 : GEN_SLOT_0
    const filePath = wx.env.USER_DATA_PATH + '/' + slot
    return new Promise((ok, no) => {
      wx.getFileSystemManager().writeFile({
        filePath,
        data: dataUrl.slice(comma + 1),
        encoding: 'base64',
        success: () => ok(filePath),
        fail: e => {
          console.error('[index] 生成结果写文件失败：' + ((e && e.errMsg) || '未知原因'))
          no(new Error('生成的图存不下来，再试一次？'))
        },
      })
    })
  },

  /**
   * 蒙层的「停止」（spec §4.3：停止掐断连接 —— 电脑版同款契约）。
   * `RequestTask.abort()` 让在飞的那次 wx.request 走 fail（errMsg 含 abort）——
   * api 层把它单独译成 ABORTED，runGenerate 的 catch 收尾说「停了。」。
   * ⚠️ 缩图那一两百毫秒里 task 还没交出来：先记 aborted，onTask 到的时候补掐。
   */
  onStopGen() {
    if (!this.data.generating) return
    this.genAbort.aborted = true
    if (this.genAbort.task) this.genAbort.task.abort()
  },

  /**
   * 「撤销」（spec §4.3）：回到**说那句话之前**的画面和参数 —— **一层，只对生成有意义**
   * （点错风格点「原图」就回去了）。撤销完按钮收掉（消费掉 undoSnap）；生成**成功**
   * 才会再亮。撤销**没走通**时（画面一个字没动）现场放回、按钮重新亮 —— 那句
   * 「再试一次？」才有个真能点的出口（Task 12 审查 Minor）。
   */
  async onUndo() {
    const snap = this.undoSnap
    const pipe = this.pipe
    const node = this.node
    if (!snap || !pipe || !node) return
    const seqAtStart = this.genPhotoSeq
    // 先消费（同步）—— 防连点两下、也防撤销半路又来一次
    this.undoSnap = null
    this.setData({ canUndo: false })
    try {
      const img = await loadImage(node, snap.photo)
      if (this.pipe !== pipe) return // 等的这会儿换了照片：撤销作废（别把旧现场盖到新照片上）
      const box = await queryStage(this)
      if (this.pipe !== pipe) return
      // ↓ 同步上屏（同 runGenerate 那条纪律）
      this.params = { ...snap.params }
      this.genPhotoSeq++
      pipe.setImage(img)
      pipe.resizeToImage()
      const k = Math.min(1, box.w / img.width, box.h / img.height)
      this.setData({
        photo: snap.photo, photoW: img.width, photoH: img.height,
        stageW: Math.round(img.width * k), stageH: Math.round(img.height * k),
        activeStyle: activePresetId(this.params, false),
      })
      pipe.render(this.params)
    } catch (e) {
      console.error('[index] 撤销没走通：', e)
      // ★ Task 12 审查 Minor：撤销失败时画面和参数**一个字没动**（所有改动都在最后
      // 一个 await 之后）—— 把快照放回去、「撤销」重新亮着，那句「再试一次？」才真
      // 有个能点的按钮；否则等于承诺了一个不存在的出口。
      // ⚠️ 只有"世界没变"才放回：等的这会儿换了照片 / 新的生成落了图，那笔现场已经
      // 翻篇（undoSnap 该是 null 或有新的），放回去 = 把旧照片的撤销挂到新照片头上。
      if (this.pipe === pipe && this.genPhotoSeq === seqAtStart) {
        this.undoSnap = snap
        this.setData({ canUndo: true })
        this.showBubble('这会儿撤不回去了，再试一次？')
      } else {
        console.info('[index] 撤销失败回来时画面已经变了，这句不提（不挂到新照片上）')
      }
    }
  },

  /**
   * 浮条（spec §4.2）：模型那句话 / 「停了。」/ 失败提示都走它，显示在输入条上方，
   * **5 秒后自动淡出**。只留一条槽 —— 新的话直接顶掉旧的（计时器重起）。
   */
  showBubble(text: string) {
    this.clearBubble()
    this.setData({ sayBubble: text })
    this.bubbleTimer = setTimeout(() => {
      this.bubbleTimer = null
      this.setData({ sayBubble: '' })
    }, BUBBLE_MS)
  },

  /** 收掉浮条（换照片 / 回空态时连着旧那句话一起清 —— 别让旧照片的话挂到新照片上）。 */
  clearBubble() {
    if (this.bubbleTimer !== null) {
      clearTimeout(this.bubbleTimer)
      this.bubbleTimer = null
    }
    if (this.data.sayBubble) this.setData({ sayBubble: '' })
  },

  /**
   * 蒙层秒表：出发时刻记下，250ms 一跳、**文案变了才 setData**（见 GEN_TICK_MS）。
   * 文案：前 5 秒「正在修…」（电脑版契约：5 秒内不显示秒数 —— 那句假想的"大约 10 秒"
   * 我们不赌）；之后「正在修…已经等了 N 秒」（结构照电脑版 busyText：秒数每秒在跳，
   * 本身就是"它还活着"的信号，比任何安抚都硬）。
   */
  startGenTicker() {
    this.stopGenTicker()
    this.genStartedAt = Date.now()
    this.genTickTimer = setInterval(() => this.tickGen(), GEN_TICK_MS)
  },

  tickGen() {
    const sec = Math.floor((Date.now() - this.genStartedAt) / 1000)
    const text = sec < GEN_SECONDS_AFTER ? '正在修…' : '正在修…已经等了 ' + sec + ' 秒'
    if (text !== this.data.genText) this.setData({ genText: text, genSeconds: sec })
  },

  stopGenTicker() {
    if (this.genTickTimer !== null) {
      clearInterval(this.genTickTimer)
      this.genTickTimer = null
    }
  },

  /**
   * 换照片 / 回空态时收在飞的生成（那一趟回来也一定作废 —— 顺手让服务端也停）。
   * ⚠️ 只掐请求，**不收界面状态**：忙态/蒙层归 runGenerate 自己的 finally 收
   * （它认得过令牌，见那边的注释）。
   */
  abortGenInFlight() {
    this.genAbort.aborted = true
    if (this.genAbort.task) this.genAbort.task.abort()
  },

  /** 蒙层 / 撤销按钮上的触摸**拦在这里**（catch 不冒泡）—— 别穿到照片区去触发
   *  「按住看原图」（按在蒙层上按住 150ms 会把照片画回原图，白闪一下）。本身不做任何事。 */
  onOverlayCatch() {},

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

  /**
   * ★ 冒烟/自动化专用（Task 12）——「说一句」的分流哨兵。**纯读、同步、立即返回**，
   * 给的是当前 15 个参数的一份拷贝。生产路径**没人读它**。
   *
   * 为什么需要它：参数存在**实例字段** `this.params` 上（有意不进 data —— 它每帧
   * 都被渲染读，进 data 会多一趟无谓的 setData 往返），探针从 page.data() 看不到
   * 它。而「说一句」两条路的核心断言全是"参数叠没叠、撤销有没有还原"（比如
   * 「亮一点」= exposure 16、拿不准那条 = exposure +6），没有它就只剩"画面变了
   * 没有"这一条粗判据。
   */
  __probeParams(): Adjustments {
    return { ...this.params }
  },

  /**
   * ★ Task 9 · 保存：**全尺寸导出 → 存进手机相册**（两半的实现在 lib/image/export.ts，
   * 导出尺寸、双路径、授权引导都在那边；这里只管流程和 toast）。
   *
   * 三件事：
   *   ① **防重复点**：`saving` 一问就早退 —— 导出+存盘这一趟可能要一两秒，
   *      连点会导出 N 张一样的图、弹 N 个系统框。顺带 `showLoading(mask)` 把页面
   *      按住（也顺手挡住"导出到一半点「换一张」"—— 管线被拆了这趟就废了）。
   *   ② **失败分两段报**：导出失败 / 存相册失败，各自一句人话（`e.message` 就是
   *      给用户看的话，见 export.ts 的文件头）。
   *   ③ 成功那声「已存到相册」在 saveToAlbum 里面 toast —— 它才知道存盘真的过了。
   */
  async onSave() {
    if (this.saving) return
    const pipe = this.pipe
    const node = this.node
    if (!pipe || !node) return
    this.saving = true
    wx.showLoading({ title: '正在保存…', mask: true })
    try {
      let exported
      try {
        exported = await exportPhoto(
          node, pipe, { width: this.data.photoW, height: this.data.photoH }, this.params)
      } catch (e) {
        // 细节 export.ts 已经打过控制台了（这里不再打第二遍）
        wx.hideLoading()
        wx.showToast({ title: (e as Error).message || '这张照片导出失败了，再点一次试试', icon: 'none' })
        return
      }
      // 界面反馈交给 saveToAlbum（成功 toast / 被拒的引导弹窗都在它里面）
      wx.hideLoading()
      try {
        await saveToAlbum(exported.path)
      } catch (e) {
        wx.showToast({ title: (e as Error).message || '存相册失败了，再点一次试试', icon: 'none' })
      }
    } finally {
      this.saving = false
    }
  },

  /**
   * ★ 探针专用（Task 9）：跑一遍导出并回报 `{ state, via, path, ms }`，同时把结果
   * 挂到实例字段 `probeExport` 上 —— **异步结果没法用 `page.callMethod` 直接拿**，
   * 探针轮询 `getCurrentPages()` 里那个字段（同 task8 读 `peekStart` 那招）。
   *
   * `force`='pixels' 时强制走 readPixels 兜底 —— 双路径要**各实测一次**，这是那条的入口。
   * ⚠️ 它**只导出、不碰相册**（保存那条路另外测）：生产路径没人调它。
   */
  async __probeExport(force?: string) {
    const pipe = this.pipe
    const node = this.node
    const running: ExportProbe = { state: 'running' }
    this.probeExport = running
    if (!pipe || !node) {
      this.probeExport = { state: 'fail', why: '没有管线（先载入照片）' }
      return this.probeExport
    }
    const t0 = Date.now()
    try {
      const r = await exportPhoto(
        node, pipe, { width: this.data.photoW, height: this.data.photoH }, this.params,
        { forceFallback: force === 'pixels' })
      this.probeExport = { state: 'ok', via: r.via, path: r.path, ms: Date.now() - t0 }
    } catch (e) {
      this.probeExport = {
        state: 'fail',
        why: e && (e as Error).message ? (e as Error).message : String(e),
        ms: Date.now() - t0,
      }
    }
    return this.probeExport
  },

  /**
   * ★ Task 11 · dev 通道那颗「试一试登录」—— 走一遍 `getToken()`（stale 有票就直接
   *  拿、没票就 wx.login → /api/wx-login），把结果 toast 一句人话（真机上人看得见），
   *  细节留在 `probeLogin` 给自动化读。**只给开发版**（wxml 里 wx:if="{{dev}}"）。
   */
  async onDevLogin() {
    const r = await this.__probeLogin()
    wx.showToast({
      title: r.state === 'ok' ? '登录好了（票 ' + r.tokenLen + ' 位）' : (r.message || '登录没成功'),
      icon: 'none',
    })
  },

  /**
   * ★ Task 11 · 探针专用：走一遍静默登录（`lib/auth.ts` 的 getToken）。
   *
   * 不带任何前置：storage 有票就拿（报长度）、没票就 wx.login → POST /api/wx-login。
   * 后端没配微信钥匙时，这里应当拿到 **503 口径**的那句「后端没有配置微信登录」
   * （不是 401 —— 401 是"重登一次"的信号，而那件事重登一百次也不会好）。
   */
  async __probeLogin(): Promise<NetProbe> {
    this.probeLogin = { state: 'running' }
    const t0 = Date.now()
    try {
      const token = await getToken()
      this.probeLogin = { state: 'ok', tokenLen: token.length, ms: Date.now() - t0 }
    } catch (e) {
      this.probeLogin = {
        state: 'fail',
        message: e && (e as Error).message ? (e as Error).message : String(e),
        code: e instanceof ApiError ? e.code : undefined,
        status: e instanceof ApiError ? e.status : undefined,
        ms: Date.now() - t0,
      }
    }
    console.info('[index] 探针登录：' + JSON.stringify(this.probeLogin))
    return this.probeLogin
  },

  /**
   * ★ Task 11 · 探针专用：打一次**需要登录**的接口（`apiPost` 的常规出口），
   * 把 401 → 清票 → 重登 → 重试一遍那条路走穿（或在不该继续的地方如实报错）。
   *
   * ⚠️ 走的路径是 `/api/me`（"我是谁"——服务端自己那条 Bearer 用例问的也是它），
   * 但**只该在"wx.request 被 mock 成脚本化响应"的探针里跑**：真服务端的
   * `/api/me` 是 GET，而 apiPost 是 POST-only，URL 在这条探针里只是个标签。
   */
  async __probeMe(): Promise<NetProbe> {
    this.probeMe = { state: 'running' }
    const t0 = Date.now()
    try {
      const r = await apiPost<{ user?: { username?: string } }>('/api/me', {})
      const name = r && r.user && r.user.username ? r.user.username : ''
      this.probeMe = { state: 'ok', message: name, ms: Date.now() - t0 }
    } catch (e) {
      this.probeMe = {
        state: 'fail',
        message: e && (e as Error).message ? (e as Error).message : String(e),
        code: e instanceof ApiError ? e.code : undefined,
        status: e instanceof ApiError ? e.status : undefined,
        ms: Date.now() - t0,
      }
    }
    console.info('[index] 探针 apiPost：' + JSON.stringify(this.probeMe))
    return this.probeMe
  },

  /**
   * ★ Task 11 · 探针专用：对这一张照片各跑一遍两条缩图（640 / 2048），
   * 结果写进 `probePrepare`；两张 dataURL 原件另挂两个字段（探针在页面里解 JPEG 头）。
   *
   * 照片用**当前正编辑的那张**，没有就用 dev 测试图 —— 缩图只看文件路径 + 尺寸，
   * 不需要真的进编辑态（这也让这条探针在空态就能跑）。
   */
  async __probePrepare(): Promise<PrepareProbe> {
    this.probePrepare = { state: 'running' }
    try {
      const path = this.data.photo || DEV_PHOTO
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>(
        (ok, no) => wx.getImageInfo({ src: path, success: ok, fail: no }))

      const t0 = Date.now()
      const route = await prepareForRouting(path, info.width, info.height)
      const routeMs = Date.now() - t0

      const t1 = Date.now()
      const model = await prepareForModel(path, info.width, info.height)
      const modelMs = Date.now() - t1

      this.prepRouteDataUrl = route
      this.prepModelDataUrl = model.dataUrl
      this.probePrepare = {
        state: 'ok',
        srcW: info.width, srcH: info.height,
        routeLen: route.length, routePrefix: route.slice(0, 23), routeMs,
        modelW: model.width, modelH: model.height, modelMs,
      }
    } catch (e) {
      this.probePrepare = {
        state: 'fail',
        why: e && (e as Error).message ? (e as Error).message : String(e),
      }
    }
    console.info('[index] 探针缩图：' + JSON.stringify(this.probePrepare))
    return this.probePrepare
  },

  /**
   * ★ 探针专用（Task 12）：「说一句」的 mock 冒烟要在**运行期**把 api 的地址指到
   * 本地 mock（`mini/scripts/mock-server.cjs`，4399）/ 跑完再指回来。为什么不直接改
   * `lib/config.ts` 那个常量：动它要触发开发者工具重编译（会话容易坏，见
   * mini/README 的「半死不活」那条）。传 '' 恢复 config 的值。
   * 生产路径**没人调它**。
   */
  __probeSetApiBase(url: string): string {
    const v = String(url || '')
    setApiBaseOverride(v)
    console.info('[index] 探针换 API 地址：' + (v || '(恢复 config)'))
    return v
  },
})
