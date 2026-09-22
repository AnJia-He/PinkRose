import type { Adjustments } from './adjustments.ts'

export type { Adjustments }

/** 路由结果：这一句话该走哪条路。三值枚举，没有第四种。 */
export type Route = 'params' | 'generate' | 'both'

/** 八个参数的增量，单位与 Adjustments 相同（[-100,100]）。缺的键视为 0。 */
export type ParamDeltas = Partial<Adjustments>

export type ParamKey = keyof Adjustments

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
}

export type RouteResponse = { decision: RouteDecision }

export type SuggestRequest = { imageDataUrl: string }
export type SuggestResponse = { cards: SuggestCard[]; degraded: boolean }

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
  | 'UPSTREAM_LIMIT'   // 429 限流，稍后重试可能成功，503
  | 'UPSTREAM_FAILED'  // 上游挂了或超时，502
  | 'INTERNAL'

export type AppError = { error: { code: AppErrorCode; message: string } }
