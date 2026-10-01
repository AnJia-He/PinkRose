import type { Adjustments } from './adjustments.ts'

/**
 * 会话的**元数据** —— 和 `WorkMeta` 同一条规矩：列表接口一次给全部，
 * 所以它要**小**，别往里加会变大的东西（比如消息、步骤）。
 */
export type SessionMeta = {
  id: number
  /** 用户起的名字。**空 = 还没起名**，显示时按 §6.3 退回原图名 */
  title: string | null
  /**
   * 用户那张照片**上传时的名字**（`古镇.jpg`）。空 = 建会话时没给。
   *
   * ⚠️ 它和硬盘上的 `original`（storage 给的不透明名字）**不是一回事**，
   * 那个永远不许出门。这一个可以出门 —— 它是用户自己的文件名。
   */
  originalName: string | null
  createdAt: number
  updatedAt: number
  hasThumb: boolean
  /** 有几步。列表上显示「3 步」比显示时间有用 */
  stepCount: number
}

export type SessionMessage = {
  id: number
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 助手那条挂在哪一步上 —— 「回到这一步」靠它。用户那条没有 */
  stepId?: number
}

/**
 * 一步。⚠️ **这里没有文件名** —— 文件名是硬盘上的东西，永远不许出门
 * （`works.ts` 那句"只给该给的"是同一条规矩）。客户端要图就去
 * `/api/sessions/:id/file/step/:stepId` 取，服务端自己知道那一步是哪张。
 *
 * `reusesPrev` = 这一步和上一步**用的是同一张图**（拖滑块那种）。
 * 客户端靠它省一次下载 + 一次解码。
 */
export type SessionStep = {
  id: number
  label: string
  params: Adjustments
  prompt?: string
  at: number
  reusesPrev: boolean
}

export type SessionDetail = SessionMeta & {
  messages: SessionMessage[]
  steps: SessionStep[]
}

/**
 * 这条会话在界面上叫什么（spec §6.3，**这个口径只有这一份**）。
 *
 * 三级退：用户起的名字 → 照片上传时的名字（去扩展名）→ 「还没说话」。
 *
 * ⚠️ 第二级**不是可有可无的**：刚上传、还一个字没说、只是拖了几下滑块 ——
 * 这是很常见的一趟，而这一趟恰恰是最需要认得出的（「古镇」「海边」一眼分得开，
 * 「3 号会话」分不开）。
 * ⚠️ 第三级也不该被当成错误：那是"这条会话确实什么都还没有"的状态，
 * 而不是一句占位文案。
 */
export function sessionTitle(
  s: Pick<SessionMeta, 'title' | 'originalName' | 'createdAt'>,
): string {
  const t = s.title?.trim()
  if (t) return t
  // 去扩展名：和 `works.ts` 的 `buildFilename` 用同一条正则
  const n = s.originalName?.trim().replace(/\.[^.]+$/, '')
  return n || '还没说话'
}
