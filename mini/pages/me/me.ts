// me.ts —— 「我的」页（Task 18 起是真页面，spec §13.3）：品牌区 + 本地作品统计 /
// 清空 + 版本页脚。数据只**消费** lib/works 的 usage() / clear() —— 那一半不动。
import { works } from '../../lib/works'

/** 结构版本（spec §13.3 页脚那行）—— 发布后再接平台版本号（从平台/发布配置读）。 */
const VERSION = '1.1'

interface MeData {
  /** 状态栏高度（navigationStyle custom，头部让位；同修图页 onLoad 那行） */
  statusBar: number
  /** usage() 的原样两份（冒烟拿页面 data 和盘上清单对账） */
  count: number
  bytes: number
  /** 数值行文案（wxml 只认文案，格式化在 ts 里做） */
  usageText: string
  /** 0 张 = 清空按钮置灰（wxml 挂 class、冒烟读它 —— 别去比颜色） */
  canClear: boolean
  version: string
}

/** 数值行显示：「N 张 · X.X MB」；0 张只留「0 张」（spec §13.3 的原话）。 */
function usageTextOf(count: number, bytes: number): string {
  if (!count) return '0 张'
  return count + ' 张 · ' + (bytes / 1048576).toFixed(1) + ' MB'
}

Page({
  data: {
    statusBar: 44,
    count: 0,
    bytes: 0,
    usageText: '0 张',
    canClear: false,
    version: VERSION,
  } as MeData,

  onLoad() {
    // 状态栏高度给头部让位（和修图页 / 作品页 onLoad 同一行口径）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: info.statusBarHeight ?? 44 })
  },

  onShow() {
    // tab 页不销毁 —— 每次露脸都重拉一遍（从修图/作品页切回来数字要对）
    this.refresh()
  },

  /** 重拉统计（onShow / 清空后各来一发）。 */
  refresh() {
    const u = works.usage()
    this.setData({
      count: u.count,
      bytes: u.bytes,
      usageText: usageTextOf(u.count, u.bytes),
      canClear: u.count > 0,
    })
  },

  /** 清空：二次确认 → clear() → 刷新 + toast。0 张时按钮已置灰，这里再守一道。 */
  onClear() {
    if (!this.data.count) return
    wx.showModal({
      title: '清空本地作品？',
      content: this.data.count + ' 张照片会一起删掉，删了就找不回了。',
      confirmText: '清空',
      confirmColor: '#ff9a8f', // = app.wxss 的 --danger（modal 只吃十六进制；改令牌跟着看）
      success: r => {
        if (!r.confirm) return
        try {
          works.clear()
          this.refresh()
          wx.showToast({ title: '清好了', icon: 'none' })
        } catch (e) {
          // 别静默：清不清得干净以 refresh 后的数字为准
          console.error('[me] 清空没跑完：', e)
          this.refresh()
          wx.showToast({ title: '没清干净，再试一次', icon: 'none' })
        }
      },
    })
  },
})
