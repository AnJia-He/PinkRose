// works.ts —— 「作品」页（Task 17 起是真页面，spec §13.2）：本地作品集的缩略图墙。
// 数据与删除全走 lib/works（USER_DATA_PATH 里 works 目录 + storage 清单），改名、
// 自动布局一律不碰。
import { works, type WorkEntry } from '../../lib/works'
import { requestEdit } from '../../lib/editBridge'

interface WorksData {
  /** 状态栏高度（navigationStyle custom，顶栏自己让位；同修图页 onLoad 那行） */
  statusBar: number
  /** 清单快照（onShow 重新拉 —— 切 tab 回来要看到新作品） */
  items: WorkEntry[]
}

Page({
  data: {
    statusBar: 44,
    items: [] as WorkEntry[],
  } as WorksData,

  onLoad() {
    // 状态栏高度给顶栏让位（和修图页 onLoad 同一行口径）。
    // ⚠️ 只让状态栏：这页右上角**没有按钮**，微信那颗胶囊盖不到谁，不用算让位宽度。
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: info.statusBarHeight ?? 44 })
  },

  onShow() {
    // tab 页不销毁 —— 每次露脸都重拉一遍，修图页刚存的作品切过来就在
    this.refresh()
  },

  /** 重拉清单（onShow / 删完各来一发）。 */
  refresh() {
    this.setData({ items: works.list() })
  },

  /** 点格 → 原生大图（左右滑、保存/转发都是微信白送的）。 */
  onTapItem(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const items = this.data.items
    const i = items.findIndex(it => it.id === id)
    if (i < 0) return // 点到了又刚好被删掉：静默，下面 refresh 会跟上
    wx.previewImage({
      urls: items.map(it => it.file),
      current: items[i].file,
    })
  },

  /** 长按格 → 二次确认 → 删（spec §13.2 说 ActionSheet，Task 17 施工单定成 modal 一步到位）。 */
  onLongPressItem(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    wx.showModal({
      title: '删除这张作品吗？',
      confirmText: '删除',
      success: r => {
        if (!r.confirm) return
        works.remove([id])
        this.refresh()
      },
    })
  },

  /** 用已经烘焙的成片作为新底图继续精修，参数归零。 */
  onEditAgain(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const work = this.data.items.find(item => item.id === id)
    if (!work) return
    requestEdit(work)
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => wx.showToast({ title: '没能打开修图页，再试一次', icon: 'none' }),
    })
  },

  /** 空态那颗按钮：回修图页（tab 页之间只认 switchTab）。 */
  onGoEdit() {
    wx.switchTab({ url: '/pages/index/index' })
  },
})
