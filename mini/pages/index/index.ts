// 页面 data 形状（后续任务只往里加字段，不改已有的）：
//   stage —— 'empty' 空态（选照片）/ 'edit' 编辑态（有照片）
//   photo —— 当前照片临时路径；空态 null
interface IndexData {
  stage: 'empty' | 'edit'
  photo: string | null
  statusBar: number
}

Page({
  data: {
    statusBar: 44,
    stage: 'empty',
    photo: null,
  } as IndexData,

  onLoad() {
    // 状态栏高度给顶栏让位（navigationStyle 是 custom，页面自己画顶栏）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: info.statusBarHeight ?? 44 })
  },

  onCamera() {}, // 任务 4
  onAlbum() {}, // 任务 4
  onPickAgain() {}, // 任务 4
  onSave() {}, // 任务 9
})
