import type { Adjustments } from './adjustments.ts'
import type { LutRef } from './lut.ts'

export type { Adjustments }

/** 路由结果：这一句话该走哪条路。三值枚举，没有第四种。 */
export type Route = 'params' | 'generate' | 'both'

/** 八个参数的增量，单位与 Adjustments 相同（[-100,100]）。缺的键视为 0。 */
export type ParamDeltas = Partial<Adjustments>

/**
 * 模型对滤镜的决定（★ 2026-10-05）。
 *   · `null`      = 这次不碰滤镜（**默认**）
 *   · `name: ''`  = 把当前的摘掉
 *   · 有名字      = 套上（`amount` 缺省 100）
 */
export type LutDecision = { name: string; amount: number }

/**
 * 模型对**用户预设**的决定（★ 2026-10-10）。
 *   · `null` = 这次不碰预设（默认）
 *   · 有名字 = 套上那一套（整组参数赋值 —— 没有"强度"这回事，所以只有名字）
 */
export type PresetDecision = { name: string }

/**
 * 一句话被理解之后的结果。
 *
 * `degraded` 是**我们自己加的**（spec §6.1 没有）：LLM 路由失败时走降级路径
 * （spec §4.7：原文当 prompt 直接走生成）。前端需要能区分"模型真这么想的"
 * 和"我们没听懂所以赌了一把"——降级那条路要花 12,900 tokens。
 */
export type RouteDecision = {
  route: Route
  paramDeltas: ParamDeltas
  reply: string
  editPrompt: string
  needsDisambiguation: boolean
  degraded: boolean
  /** ★ 2026-10-05：滤镜那半。必填 —— 新增字段就该逼每个构造点表态。 */
  lut: LutDecision | null
  /**
   * ★ 2026-10-10：用户预设那半。必填 —— 新增字段就该逼每个构造点表态。
   * 和 `lut` 完全平行：清单送上去（`RouteRequest.presets?`）、模型**只回名字**、
   * 前端自己对号赋值（名字不在清单里时 `validate.ts` 归 null + degraded）。
   */
  preset: PresetDecision | null
}

export type SuggestCard = {
  label: string
  route: Route
  paramDeltas: ParamDeltas
  editPrompt: string
}

export type RouteRequest = {
  /** 缩略预览图（长边 <= 1024 的 JPEG data URL）。路由不需要全分辨率。 */
  imageDataUrl: string
  text: string
  /** 用户当前参数。给 LLM 当上下文，让它在写生成 prompt 时补偿（spec §3.5）。 */
  params: Adjustments
  /**
   * ★ 2026-10-05：用户导入的滤镜清单（最多 30 条）—— **模型靠名字认它们**
   * （"用那个黄昏滤镜"）。只给名字，不给内容。
   */
  luts?: { id: number; name: string }[]
  /** ★ 用户当前用着的滤镜（没写进清单也没关系，服务端只拿它写进提示词） */
  lut?: LutRef | null
  /**
   * ★ 2026-10-10：用户保存的预设清单 —— **名字 + 参数**都给（模型靠名字认它们，
   * 参数当上下文；spec §8.1 定的"名字 + 参数一起发给模型"）。
   * 条数上限 30 的截断在**服务端**做（`server/route.ts` 的 `normalizePresetList`）
   * —— 请求可以伪造，前端的截不算数。
   */
  presets?: { name: string; params: Adjustments }[]
}

export type RouteResponse = { decision: RouteDecision }

export type SuggestRequest = { imageDataUrl: string }
export type SuggestResponse = { cards: SuggestCard[]; degraded: boolean }

/**
 * 「测一下」（`POST /api/models/test`）的结果形状。
 *
 * ★ 2026-09-30 从两边收进来的：`server/modeltest.ts` 和 `src/api/models.ts`
 * 原来各写了一遍（当时注释还写着"一字不差"）。**这种重复是静默的** ——
 * 联合类型在运行时不存在，服务端多一个成员、前端少一个，编译器一个字都不说，
 * 而界面按 `reason` 分流的那天就会漏掉一格。今天正好要给这个联合加一个成员
 * （5xx → `server_error`），所以先收成一份。
 *
 * ⚠️ **探不通也是 200** —— 那是"这次探活的结果"，不是"这次请求失败了"。
 *    `message` 是**给用户看的那句话**（上游原文被服务端挡在外面），界面原样显示。
 */
export type ProbeFail =
  | 'unauthorized'   // 401 / 403，以及其余 4xx：服务商不认这把钥匙
  | 'unreachable'    // DNS 失败 / 超时 / 拒连：地址到不了
  | 'no_endpoint'    // 404 / 405：地址上没有这个接口
  | 'server_error'   // >= 500：地址通、钥匙认，是服务商那边自己出错了
  | 'bad_response'   // 200 但不是 JSON：多半填的不是 AI 服务商的接口地址
  // ★ 2026-10-02 加：3xx。我们**故意不跟重定向**（跟的话地址校验可以被
  //   一跳 3xx 绕去内网），所以它要有自己的一类，好让用户看到一句能照着改的话。
  | 'redirect'

export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: ProbeFail; message: string }

export type EditRequest = {
  /** 已由前端备好：sRGB、长边 <= 2048、宽高均为 32 的倍数、不含当前调色参数。 */
  imageDataUrl: string
  /** 已经带保留项的长英文 prompt，前端从 RouteDecision.editPrompt 直接转发。 */
  editPrompt: string
  width: number
  height: number
}

export type EditResponse = { imageDataUrl: string; width: number; height: number }

export type AppErrorCode =
  | 'BAD_REQUEST'      // 请求体不合法，改请求也没用，400
  | 'UNAUTHORIZED'     // 没登录、或票过期了 —— 先登录，401
  // ★ 服务商**不认这把钥匙**（上游 401/403）。和"上游拒了这次请求"（提示词/图片不合规）
  //   是两回事，文案也完全不同：这里要让人去查钥匙，那里才是"换个说法试试"。
  //   归进 BAD_REQUEST 的话，用户会收到一句"换个说法试试"——而真正的问题是钥匙，
  //   他改一百遍措辞也没用（2026-09-30 加）。
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_LIMIT'   // 429 限流，稍后重试可能成功，503
  | 'UPSTREAM_FAILED'  // 上游挂了或超时，502
  // ★ 2026-10-02 加（安全审计 H2/S3）：**我们自己**的限流（不是上游的）。
  //   和 UPSTREAM_LIMIT 分开，因为下一步动作不一样：那条是"等上游缓过来"，
  //   这条是"你打得太快了，慢一点"。
  | 'TOO_MANY'
  // ★ 2026-10-02 加（安全审计）：同一条会话被两条路同时改，后到的那条**明确失败**。
  //   在它之前是"两次都回 200，先写的那一步静默消失" —— 这个项目最恨的那一类。
  | 'CONFLICT'
  | 'INTERNAL'
