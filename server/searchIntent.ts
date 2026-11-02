import { coerceToObject } from './validate.ts'

export type SearchIntent = { query: string }

const PUBLIC_FACT_CUE =
  /多少钱|价格|最新|今天|近日|最近|参数|规格|新闻|是谁|在哪里|天气|怎么样/iu
const PRIVATE_CONTEXT_CUE =
  /我|你|他|她|朋友|家人|同事|老婆|老公|男朋友|女朋友|孩子|账号|手机号|电话|邮箱|地址|照片|图片|这张|那张|这个|那个|这台|那台|画面|人物|背景|脸|自拍|修图|调色|磨皮|美白|裁剪|构图|去掉|帮我|给我/iu

/** 解析模型给的服务端内部搜索请求；公开响应里不会出现这个字段。 */
export function parseSearchIntent(raw: unknown): SearchIntent | null {
  const obj = coerceToObject(raw)
  const value = obj?.web_search ?? obj?.webSearch
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const query = typeof (value as Record<string, unknown>).query === 'string'
    ? ((value as Record<string, unknown>).query as string).replace(/\s+/g, ' ').trim().slice(0, 200)
    : ''
  return query.length >= 2 ? { query } : null
}

/**
 * 高置信的独立公开事实问题可以在第一次模型调用前直接搜索。
 *
 * 这类问题不需要模型先判断“知不知道”，因此搜索 + 单次回答即可完成，
 * 避免低 RPM 账户连续两次模型调用时第二次必然被限流。
 *
 * 只要出现照片、人物关系、账号或私人上下文，就一律返回 null，继续走
 * “模型生成隐藏搜索词”的保守链路；用户原文不会因为这些启发式规则被外发。
 */
export function parsePublicSearchQuery(text: string): string | null {
  const query = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (query.length < 4 || query.length > 200) return null
  if (/https?:\/\//iu.test(query)) return null
  if (PRIVATE_CONTEXT_CUE.test(query)) return null
  if (!PUBLIC_FACT_CUE.test(query)) return null

  // 快捷路需要明确的英文 / 数字型号（Sony A7 IV、iPhone 17 Pro、GPT-5），
  // 泛化问题（“最近发布的新相机”）仍交给模型生成搜索词。
  const entity = query.match(
    /\b[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z0-9][A-Za-z0-9-]*){1,4}\b/u,
  )?.[0]?.trim()
  if (!entity || !/\d/u.test(entity)) return null

  // 搜索结果只保留精确型号：Bing 对“型号 + 价格/规格”的追加词经常退回品牌首页，
  // 反而丢掉产品页；“问的是价格还是规格”由用户原话交给随后那一次模型调用理解。
  return entity.slice(0, 200)
}
