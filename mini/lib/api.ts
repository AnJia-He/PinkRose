import { API_BASE, API_BASE_OVERRIDE } from './config'
import { clearToken, getToken } from './auth'

/**
 * 「和电脑版后端说话」的唯一出口（Task 11）。
 *
 * 三件事：
 *   ① **地址**：`API_BASE`（局域网 IP + vite 的 5173，见 config.ts），调试期可被
 *      `API_BASE_OVERRIDE` 顶掉 —— 拼地址只有 `post()` 那一处说了算；
 *   ② **票**：每次请求都带 `Authorization: Bearer <票>`。小程序没有 cookie jar
 *      （收下 Set-Cookie 也不会带回去），所以电脑版那套 cookie 会话在这边走 Bearer ——
 *      服务端 `sessionTokenOf` 把两个入口翻译成同一张票（server/app.ts），我们这边
 *      只管带；
 *   ③ **401 = 票不灵了**：清掉 → 重登一次（`getToken` 见空会去走 wx.login）→
 *      把**这一次请求**重试一遍。**只重试一次**：重试再 401 就原样抛出去。
 *
 * ⚠️ 本文件和 auth.ts **互相引用**（这边要 getToken/clearToken，那边要
 * `apiPostNoAuth` 打登录接口）—— 两边都只在**函数体里**碰对方的导出、模块顶层
 * 一个字不执行，所以没有"模块还在初始化"的坑。登录那次调用**故意绕过** getToken：
 * 走 apiPost 的话 `getToken → 登录 → getToken` 会转圈，入口专门叫 `apiPostNoAuth`。
 *
 * 错误纪律（和 `lib/image/export.ts` 同一条）：**抛出去的 Error，message 就是
 * 能直接给用户看的话**。服务端错误体里的 message 原样转（那是照 spec §6.3 写死的
 * 中文），技术英文（`request:fail timeout` 之类）只进 console、不往界面上甩 ——
 * 对齐电脑版 `api/client.ts` 里 `errorText` 的口径。
 */

/** 服务端错误码（spec §6.3）。电脑版那份是 shared/protocol.ts 的联合类型，
 *  那份没同步进小程序（这边用不上全量类型）—— code 只当字符串带出去。 */
export class ApiError extends Error {
  readonly code: string
  /** HTTP 状态码；"根本没到服务端"（连不上 / 200 但不是 JSON）是 `null`
   *  —— 和电脑版 `ApiError.status` 同一个口径。 */
  readonly status: number | null

  constructor(code: string, message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** 实际打哪个地址：调试覆盖优先（config.ts 那段写着什么时候填、什么时候清）。
 *  ★ Task 12：「说一句」的 mock 冒烟要**运行期**把它指到本地 mock（4399）——
 *  改 config.ts 那个常量会触发开发者工具重编译（会话容易坏，见 mini/README
 *  的「半死不活」那条），所以这里留一个 setter 给探针。默认值仍是 config 的常量，
 *  生产路径没有任何地方调 setter。 */
let baseOverride: string = API_BASE_OVERRIDE

/** 运行期换地址（**只给探针/冒烟用**）。传 '' 恢复 config.ts 的值。 */
export function setApiBaseOverride(url: string): void {
  baseOverride = url
}

function baseUrl(): string {
  return baseOverride || API_BASE
}

/** 服务端错误体的形状：`{ error: { code, message } }`（server/http.ts 的 sendJson） */
interface ErrorBody {
  error?: { code?: string; message?: string }
}

/**
 * 可选的两样（★ Task 12）—— 都只有「说一句」的生成那条路用：
 *
 *   · `timeoutMs` —— 覆盖 `wx.request` 的默认超时（**60 秒**，基础库 2.10.0 起
 *     才有 timeout 这个字段）。为什么生成那条路要显式给一个更大的值：
 *     `/api/edit` 在服务端要过**全局串行队列**（server/queue.ts），一次商汤
 *     编辑本身 4~8.5 秒、上游自己的超时是 180 秒（sn.ts 的 EDIT_TIMEOUT_MS）——
 *     队列里前面还排着别人的时候，60 秒的默认值会被**正常但排队久**的请求撞上，
 *     而打出去失败会被下面译成「连不上服务器，检查一下网络？」——那是**假话**
 *     （网好着呢，是等得久）。页面给的是 120 秒（见 index.ts 的 EDIT_TIMEOUT_MS）。
 *
 *   · `onTask` —— 把这一次请求的 `RequestTask` 交出去（「停止」按钮要按它的
 *     `abort()`）。⚠️ 401 重登重试时**两次请求都会回调一次**：调用方拿到的
 *     是**最近一次**的 task，abort 要打最新的那个（页面里 aborted 旗标兜底：
 *     task 来晚了就直接掐）。
 */
export interface PostOptions {
  timeoutMs?: number
  onTask?: (task: WechatMiniprogram.RequestTask) => void
}

/** 「这一次请求是被 abort 掉的」—— 不是网络故障（见 post 的 fail 分支）。 */
export function isAbortError(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ABORTED'
}

/**
 * 打一次 POST —— **唯一**碰 `wx.request` 的地方（url / method / header 都在这儿定）。
 *
 * @param token 非空就带 `Authorization: Bearer <token>`；登录那一次传 null。
 */
function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  token: string | null,
  opts?: PostOptions,
): Promise<T> {
  return new Promise<T>((ok, no) => {
    const task = wx.request({
      url: baseUrl() + path,
      method,
      // 不传就是平台默认（60 秒）——只在调用方显式要的时候才写进去
      ...(opts && opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      header: {
        'content-type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      // 自己 stringify：发出去的正文长什么样只由这一行决定，不赌平台的默认序列化
      ...(method === 'GET' ? {} : { data: JSON.stringify(body) }),
      success: res => {
        const status = res.statusCode
        const data: unknown = res.data
        if (status >= 200 && status < 300) {
          if (data && typeof data === 'object' && !(data instanceof ArrayBuffer)) return ok(data as T)
          // 200 但正文不是 JSON（代理插了个 HTML 报错页之类）
          console.error('[api] ' + path + ' 回了 200，但正文不是 JSON：' + String(data).slice(0, 200))
          return no(new ApiError('UPSTREAM_FAILED', '服务器返回了看不懂的东西，再试一次？'))
        }
        const err = (data as ErrorBody | null)?.error
        const message = err && typeof err.message === 'string' && err.message
          ? err.message
          : '出了点问题，再试一次？'
        no(new ApiError(err && typeof err.code === 'string' ? err.code : 'INTERNAL', message, status))
      },
      fail: e => {
        const msg = String((e && e.errMsg) || e)
        console.error('[api] ' + path + ' 打不出去：' + msg)
        // ★「停止」按下的那一下：wx.request 被 abort → 走 fail，errMsg 含 'abort'。
        //   这不是故障，单独认出来（页面照着它说「停了。」，不说"没改成"）。
        if (msg.indexOf('abort') >= 0) return no(new ApiError('ABORTED', '已停止'))
        // 超时和"真连不上"分开说：等了 120 秒没回来时，「检查一下网络」
        // 是句假话（网好的，是服务端那边慢 / 队列长）——文案规范 §5 哪不对+怎么办。
        if (msg.indexOf('timeout') >= 0) {
          return no(new ApiError('UPSTREAM_FAILED', '服务器这次回得太慢，再试一次？'))
        }
        no(new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？'))
      },
    })
    // 把掐断开关交给调用方（「停止」）。放在 wx.request 返回之后、同一个 tick 里。
    if (opts && opts.onTask) opts.onTask(task)
  })
}

function post<T>(path: string, body: unknown, token: string | null, opts?: PostOptions): Promise<T> {
  return request('POST', path, body, token, opts)
}

/**
 * **不带票**的那一次 POST —— 只给 auth.ts 的登录调用用（名字把这件事写在脸上）。
 * 别的任何地方都不该调它：绕开票就等于绕开身份。
 */
export function apiPostNoAuth<T>(path: string, body: unknown): Promise<T> {
  return post<T>(path, body, null)
}

/**
 * 带票 POST —— 页面（「说一句」那几条路）的常规出口。
 *
 * 401 的处置：**清票 → 重登一次 → 重试一遍，就这些**。重试那一句写在 try/catch
 * **外面** —— 所以"只重试一次"不是靠自觉，是结构：它再 401 就直接抛出去，
 * 由调用方接住说话（再撞一百次也不会好，那多半是"这台设备上的票被换过了"）。
 */
export async function apiPost<T>(path: string, body: unknown, opts?: PostOptions): Promise<T> {
  try {
    return await post<T>(path, body, await getToken(), opts)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    console.warn('[api] ' + path + ' 回了 401 —— 清掉旧票、重登一次再试')
    clearToken()
    // opts 两次都传：重试那一次也要有超时和 onTask（abort 要能掐到**正在飞的那一个**）
    return await post<T>(path, body, await getToken(), opts)
  }
}

/** 带票 GET；401 清票重登并重试一次，和 apiPost 同一条会话纪律。 */
export async function apiGet<T>(path: string, opts?: PostOptions): Promise<T> {
  try {
    return await request<T>('GET', path, null, await getToken(), opts)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    clearToken()
    return await request<T>('GET', path, null, await getToken(), opts)
  }
}
