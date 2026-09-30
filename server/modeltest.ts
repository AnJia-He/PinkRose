/**
 * 「测一下」这个按钮背后那一下。
 *
 * ★ **它不花一分钱。** 打的是 `GET {baseUrl}/models` —— OpenAI 标准接口，
 * 实测商汤支持。这是刻意的：用户会反复按这个按钮，让它烧 token 是不能接受的。
 *
 * ⚠️ **它证明的是「地址通、钥匙对」，不是「那个模型能用」。** 那句话必须同时
 * 出现在界面文案里（§7.3：不许写产品做不到的事）。想验模型名就得真发一次生成。
 *
 * ⚠️ **模型名单不全，只能当建议。** 实测商汤的 /models 里**没有**
 * sensenova-u1.5-fast —— 我们自己在用的图片模型。所以：
 * 调用方**绝不能**因为"名单里没有"就判用户填错，界面里必须留着"自己手打"。
 */

import type { ProbeFail, ProbeResult } from '../shared/protocol.ts'

/** 超时。这是个人在等的一次点击，比 AI 那几条路短得多。 */
const PROBE_TIMEOUT_MS = 8000

export type ProbeInput = { baseUrl: string; apiKey: string }

/**
 * 失败时给用户看的话。
 *
 * ⚠️ 这里每一个字都是**给人看的**，不是运维口径 ——
 * `ENOTFOUND` / `ECONNREFUSED` / 上游原文一律不许出现在这里面
 * （它们是"我们自己排查用的"，出给用户只会让他放弃）。
 *
 * 「钥匙不认」那条照 Chatbox 的抄：它把新手最容易踩的几种一次说全，
 * 用户读完能自己去改，不必来问我们。
 */
function messageOf(reason: ProbeFail): string {
  switch (reason) {
    case 'unauthorized':
      return '服务商不认这把钥匙。常见的几种：没复制全、前后多了空格、跟这个服务商对不上、余额不够了、或者已经过期。'
    case 'unreachable':
      return '连不上这个接口地址。检查一下地址有没有写错、网络通不通。'
    case 'server_error':
      // ★ 5xx **不能和"连不上"共用一句话**（2026-09-30 修）。
      // 5xx 意味着地址是**通的**、请求也**到了**，是服务商那边自己出了错 ——
      // 说成"连不上这个接口地址"是句假话，而且它给用户的下一步动作是错的：
      // 他会去改一个本来没错的地址（《文案规范》第三条：不许写产品做不到的事）。
      // 这条的下一步动作只有一个：**等一会儿再来**。
      return '那边的服务出了点问题，过一会儿再试。'
    case 'no_endpoint':
      return '这个地址上没有那个接口。多半是地址少了或多了 `/v1` 这类结尾。'
    case 'bad_response':
      return '那个地址回了一个我们看不懂的东西。确认一下填的是 AI 服务商的接口地址。'
  }
}

/** 失败一律走这里 —— 保证"用户看到的话"和"我们记的日志"永远是两回事。 */
function fail(reason: ProbeFail): ProbeResult {
  return { ok: false, reason, message: messageOf(reason) }
}

export async function probeConnection(
  input: ProbeInput, fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/models`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    // DNS 失败 / 连不上 / 超时 —— 对用户来说都是"这个地址到不了"
    return fail('unreachable')
  }

  // ⚠️ **400 不单列**（这条注释原来和代码说的是反的，2026-09-30 改正）。
  //
  // 旧注释写着「只认 401 / 403，不吃 400：有些服务商的 400 是"你这个模型名不对"，
  // 把它归到钥匙类等于让用户去换一把本来就对的钥匙」—— 而下一行那句 4xx 兜底
  // **确实**把 400 归到了 `unauthorized`。注释和代码说两件事的后果不是"读起来别扭"：
  // 下一个人信了注释，就会把那个 400 分支加回来（这次执行里明令删掉的一行）。
  //
  // 今天的样子是**故意的**：400 落到下面的 4xx 兜底 → `unauthorized`。
  // 理由：这个探活打的是 `GET {base}/models`，**我们不发任何"可能填错"的参数**，
  // 所以这里的 400 说明不了"模型名不对"；而它和 401/403 给用户的是同一个下一步
  // —— 回头核一遍地址和钥匙。
  //
  // ⚠️ **也别顺手把它挪进 `no_endpoint`**：那一类说的是"这个地址上没有那个接口"
  // （404/405），下一步是去改地址。指错了路比不说还坏。
  if (res.status === 401 || res.status === 403) {
    return fail('unauthorized')
  }
  // 404 / 405：地址不对（或者那家根本没有列模型这个接口）
  if (res.status === 404 || res.status === 405) return fail('no_endpoint')
  // 其余 4xx 基本也是"这个凭证/这个地址不对"，归到钥匙那一类更好懂
  if (res.status >= 400 && res.status < 500) return fail('unauthorized')
  // >= 500：**地址通、钥匙认了**，是服务商那边自己出错了。
  // 所以它有自己的一类（不是 unreachable）—— 见 messageOf 里那段。
  if (res.status >= 500) return fail('server_error')

  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    return fail('bad_response')
  }
  const data = (body as { data?: unknown })?.data
  // ★ 拿不到名单**不算失败** —— 有些服务商就是不给列表，
  //   而我们的目的是验"地址通、钥匙对"，那个目的已经达到了。
  if (!Array.isArray(data)) return { ok: true, models: [] }
  const models = data
    .map(m => (m as { id?: unknown })?.id)
    .filter((x): x is string => typeof x === 'string')
  return { ok: true, models }
}
