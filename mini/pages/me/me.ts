// me.ts —— 「我的」页（Task 18 起是真页面，spec §13.3）：品牌区 + 本地作品统计 /
// 清空 + 版本页脚。数据只**消费** lib/works 的 usage() / clear() —— 那一半不动。
import { works } from '../../lib/works'
import { ORIGINAL_ID, PRESETS } from '../../lib/shared/presets'
import { getDefaultStyle, setDefaultStyle } from '../../lib/prefs'
import { apiGet } from '../../lib/api'
import { clearToken, getToken } from '../../lib/auth'
import { modelLabelOf, type ModelStatus } from '../../lib/status'

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
  styleOptions: { id: string; label: string }[]
  styleIndex: number
  defaultStyleLabel: string
  serviceState: 'idle' | 'checking' | 'ok' | 'fail'
  serviceText: string
  accountText: string
  modelText: string
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
    styleOptions: [
      { id: ORIGINAL_ID, label: '原图起手' },
      ...PRESETS.map(item => ({ id: item.id, label: item.label })),
    ],
    styleIndex: 0,
    defaultStyleLabel: '原图起手',
    serviceState: 'idle',
    serviceText: '尚未检查',
    accountText: '未登录',
    modelText: '尚未检查',
  } as MeData,

  onLoad() {
    // 状态栏高度给头部让位（和修图页 / 作品页 onLoad 同一行口径）
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: info.statusBarHeight ?? 44 })
  },

  onShow() {
    // tab 页不销毁 —— 每次露脸都重拉一遍（从修图/作品页切回来数字要对）
    this.refresh()
    this.refreshPrefs()
    void this.checkServices(false)
  },

  refreshPrefs() {
    const id = getDefaultStyle(this.data.styleOptions.map(item => item.id))
    const index = id ? this.data.styleOptions.findIndex(item => item.id === id) : 0
    const safeIndex = index >= 0 ? index : 0
    this.setData({
      styleIndex: safeIndex,
      defaultStyleLabel: this.data.styleOptions[safeIndex].label,
    })
  },

  onDefaultStyleChange(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value)
    const option = this.data.styleOptions[index]
    if (!option) return
    try {
      setDefaultStyle(option.id === ORIGINAL_ID ? null : option.id)
      this.setData({ styleIndex: index, defaultStyleLabel: option.label })
      wx.showToast({ title: '下一张照片会按这个风格起手', icon: 'none' })
    } catch (err) {
      console.error('[me] 默认风格没保存下来：', err)
      wx.showToast({ title: '没保存下来，再试一次', icon: 'none' })
    }
  },

  onCheckServices() {
    void this.checkServices(true)
  },

  /** 检查登录、接口和图片模型状态；force 会清掉旧票，真正重走微信登录。 */
  async checkServices(force: boolean) {
    if (this.data.serviceState === 'checking') return
    if (force) clearToken()
    this.setData({
      serviceState: 'checking',
      serviceText: '正在检查…',
      accountText: force ? '正在重新登录…' : '正在确认微信登录…',
    })
    try {
      await getToken()
      const [me, models] = await Promise.all([
        apiGet<{ user: { username: string } }>('/api/me'),
        apiGet<{ configs: ModelStatus[] }>('/api/models'),
      ])
      this.setData({
        serviceState: 'ok',
        serviceText: '服务连接正常',
        accountText: me.user.username ? '微信登录正常：' + me.user.username : '微信登录正常',
        modelText: modelLabelOf(models.configs),
      })
    } catch (e) {
      console.error('[me] 服务检查没通过：', e)
      this.setData({
        serviceState: 'fail',
        serviceText: e && (e as Error).message ? (e as Error).message : '连不上服务器，检查网络',
        accountText: '登录状态不可用',
        modelText: '暂时无法确认',
      })
    }
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
