/**
 * ★ 2026-10-08（用户原话：「属于一段对话的记录被删除了，另一条对话记录还被保留
 *   这肯定不对的」+ 一张截图：删掉回复之后，问句孤零零地杵在对话区里）：
 * **删一条 = 删掉它这一问一答**。
 *
 * 根因：删除的单位一直是**一条消息**，而"一段对话"在他那儿是**一问一答**
 * （他自己定的：2026-10-06「一问一答就是一段对话」—— 那也是「…」一轮一颗的
 * 依据）。于是"点回复上的删除"只掉一条、问句还在：屏幕上留下一个没人回答的
 * 问题，他看着就是坏的。
 *
 * 一对 = **相邻且角色相反的那两条**：
 *   · 助手那条 → 看它**前一条**（是用户话 → 成对）；
 *   · 用户那条 → 看它**后一条**（是助手话 → 成对）。
 *
 * ⚠️ 两个刻意不做的（都是这一轮想过又不要的）：
 *   · **不把"连续几条助手"整体当成一个答案**（同一句话重掷过之后，原回复后面
 *     会再挂一条助手消息，而**它身后挂着它自己的那一步/图**）。那样删"最早
 *     那条回复"会顺手把后面重掷出来的新版本连坐删掉 —— 用户没说要那个。
 *     （这条保住的原来还有"工具记录"（「裁好了。」「擦干净了。」）—— ★ 2026-10-08
 *     起那两句**不再进对话区**了（裁剪/点修是调色区里的操作，见 `App.tsx` 的
 *     `commitCrop` 那段），所以今天它保的主要是重掷那一条。）
 *   · **没有搭子就删它自己**：残缺的老数据（只有问句没有回答、或者反过来）
 *     照样删得掉；重掷出来的第二句回复（前一条也是助手）也只删它自己。
 */
export type ChatLike = { id: number; role: 'user' | 'assistant' }

/** 这一条消息的"问答搭子"id（相邻、角色相反）；没有就 null。 */
export function qaMateOf(messages: readonly ChatLike[], id: number): number | null {
  const i = messages.findIndex((m) => m.id === id)
  if (i < 0) return null
  const m = messages[i]!
  const other = m.role === 'assistant' ? messages[i - 1] : messages[i + 1]
  if (!other || other.role === m.role) return null
  return other.id
}

/** 把一批要删的 id 补成"整问整答"：每一条都带上它的搭子。
 *  id 不在列表里就原样留着（删除账本认的是 id，别在这里吞掉它）。 */
export function expandDeleteIds(messages: readonly ChatLike[], ids: readonly number[]): number[] {
  const out = new Set(ids)
  for (const id of ids) {
    const mate = qaMateOf(messages, id)
    if (mate !== null) out.add(mate)
  }
  return [...out]
}
