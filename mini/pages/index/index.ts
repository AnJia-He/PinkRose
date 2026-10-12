// 页面 data 形状（后续任务只往里加字段，不改已有的）：
//   stage —— 'empty' 空态（选照片）/ 'edit' 编辑态（有照片）
//   photo —— 当前照片临时路径；空态 null
//   photoW / photoH —— 照片的像素尺寸（渲染任务按它摆布局）
//   statusBar —— 状态栏高度，顶栏自己让位用
//   topbarPadRight —— 顶栏右侧给微信那颗胶囊（••• | ⊙）让出的宽度
interface IndexData {
  stage: 'empty' | 'edit'
  photo: string | null
  photoW: number
  photoH: number
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

Page({
  data: {
    statusBar: 44,
    topbarPadRight: 16, // 首屏占位；onLoad 里按胶囊位置换真值（32rpx ≈ 375 宽下的 16px）
    stage: 'empty',
    photo: null,
    photoW: 0,
    photoH: 0,
  } as IndexData,

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

  /** 选照片 → 量尺寸 → 进编辑态。取消不提示，真失败才给一句人话。 */
  async loadFrom(source: 'camera' | 'album') {
    try {
      const path = await pickPhoto(source)
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>(
        (ok, no) => wx.getImageInfo({ src: path, success: ok, fail: no }))
      this.setData({ stage: 'edit', photo: path, photoW: info.width, photoH: info.height })
    } catch (e) {
      // 用户取消（errMsg 含 cancel）不是错，别的才提示
      if (!String((e as { errMsg?: string })?.errMsg).includes('cancel')) {
        wx.showToast({ title: '这张照片打不开，换一张试试', icon: 'none' })
      }
    }
  },

  onPickAgain() { this.setData({ stage: 'empty', photo: null, photoW: 0, photoH: 0 }) },
  onSave() {}, // 任务 9
})
