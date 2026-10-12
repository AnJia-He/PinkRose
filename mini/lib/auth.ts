import { apiPostNoAuth } from './api'

/**
 * 静默微信登录（Task 11 / spec §6.1-6.2）：**没有登录页、没有授权弹窗**。
 *
 * `getToken()` 是唯一入口：
 *   · storage 里有票 → 原样拿出来用。**不验有效期** —— 过没过期让服务端说了算：
 *     哪次请求真的 401 了，api.ts 会清票再回到这里重登一次。本地再养一套"什么时候
 *     算过期"的规矩，只会和服务端签名的寿命两处会漂；
 *   · 没有 → `wx.login()` 拿 code（拿 code 本身不弹窗，这是"静默"的前提）→
 *     `POST /api/wx-login`（**不带票**，走 api.ts 的 apiPostNoAuth）→ 服务端
 *     拿 AppID/Secret 去换 openid、找/建账号、发一张和电脑版登录同一套的票 →
 *     票存 `pr_token`、人存 `pr_user`。
 *
 * 票的**用法**在 api.ts（`Authorization: Bearer`），这里只管拿和存。
 * ⚠️ **绝不 print 票本身**（日志/探针只报长度）。
 */

/** storage 里两把钥匙的键名 —— 只活在这一层，外面只需要 getToken/clearToken。 */
const TOKEN_KEY = 'pr_token'
const USER_KEY = 'pr_user'

/** 服务端 PublicUser 的镜像（server/account.ts）—— 第一版只拿它做展示/排查，
 *  认人从头发到尾是**票**，不是这几格字段。 */
export type WxUser = { id: number; username: string; email: string }

/** 清掉这份身份的本地痕迹。票和人**是一对**（有 user 必有 token 是这层的不变量）
 *  —— 只清一半会留下"上一个人是谁"的残影，没有意义还难看。 */
export function clearToken(): void {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(USER_KEY)
}

/** 拿票：有就用，没有就去登（两条见文件头）。 */
export async function getToken(): Promise<string> {
  const cached = wx.getStorageSync<string>(TOKEN_KEY)
  if (typeof cached === 'string' && cached) return cached
  return await login()
}

/** 走一趟「wx.login → 换票 → 落 storage」。只该由 getToken 叫（401 重登那条路
 *  也是先 clearToken、再 getToken，最后回到这儿）。 */
async function login(): Promise<string> {
  const code = await wxLoginCode()
  const r = await apiPostNoAuth<{ user: WxUser; token: string }>('/api/wx-login', { code })
  wx.setStorageSync(TOKEN_KEY, r.token)
  wx.setStorageSync(USER_KEY, r.user)
  return r.token
}

/** `wx.login` —— 静默的那一半。失败那句话和服务端「微信登录没成功，再试一次」
 *  一个字不差：两条半路各自失败的提示，用户看到的应该是同一句。 */
function wxLoginCode(): Promise<string> {
  return new Promise((ok, no) => {
    wx.login({
      success: r => {
        if (r.code) return ok(r.code)
        console.error('[auth] wx.login 回了个空 code')
        no(new Error('微信登录没成功，再试一次'))
      },
      fail: e => {
        console.error('[auth] wx.login 失败：' + ((e && e.errMsg) || String(e)))
        no(new Error('微信登录没成功，再试一次'))
      },
    })
  })
}
