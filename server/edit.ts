import type { EditRequest, EditResponse } from '../shared/protocol.ts'
import { MAX_DIMENSION, checkModelSize } from '../shared/size.ts'
import { HttpError, asImageBody } from './http.ts'
import { buildEditPrompt } from './prompt.ts'
import type { SerialQueue } from './queue.ts'
import { SnError, type ModelClient } from './sn.ts'

export type EditDeps = {
  // 接口类型（★ 2026-10-05）：改图只走「图片」那一路，而 Anthropic 形状
  // **没有图片生成**（它的 edit() 会抛）—— 所以 image × anthropic-compatible
  // 在 models.ts 存配置那一层就拒了，那种组合到不了这里。
  client: ModelClient
  queue: SerialQueue
  /**
   * 用户按了「停止」时会被 abort（★ 2026-09-30）。
   * 挂在 app.ts 的 `/api/edit` 那一支上、监听 `res` 的 close —— 浏览器掐断
   * 连接就是这里收到信号的时刻。**不传 = 老行为**（没有取消这一说）。
   */
  signal?: AbortSignal
}

export async function handleEdit(raw: unknown, deps: EditDeps): Promise<EditResponse> {
  const req = parseRequest(raw)
  const prompt = buildEditPrompt(req.editPrompt)

  const b64 = await deps.queue.run(() => {
    // ★ 还在排队的时候用户就按了停止 —— **一次上游都不打**。
    //   这是"停止"真能省下钱的那一格：队列是串行的，前面有人时这次请求
    //   可能干等十几秒，而用户在这十几秒里反悔是常事。
    //   （已经在跑的那种救不回来 —— 上游早收下了那张图，钱已经花了。
    //     前端那句"停了"也因此不承诺省钱，只说停了。）
    if (deps.signal?.aborted) {
      throw new SnError('UPSTREAM_FAILED', '用户取消了这次生成', false)
    }
    return deps.client.edit({
      imageDataUrl: req.imageDataUrl,
      prompt,
      size: { width: req.width, height: req.height },
    }, deps.signal)
  }, 'edit')

  return {
    imageDataUrl: `data:image/png;base64,${b64}`,
    width: req.width,
    height: req.height,
  }
}

function parseRequest(raw: unknown): EditRequest {
  // 请求体得是对象、`imageDataUrl` 得是 data URL —— 两条都在 `http.ts` 的
  // `asImageBody` 里（三个 AI 入口共用）。
  const { o, imageDataUrl } = asImageBody(raw)

  const editPrompt = typeof o.editPrompt === 'string' ? o.editPrompt.trim() : ''
  if (!editPrompt) throw new HttpError('BAD_REQUEST', 'editPrompt 不能为空', 400)

  const width = o.width
  const height = o.height
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new HttpError('BAD_REQUEST', 'width / height 必须是数字', 400)
  }

  // 尺寸校验放在这里、调 API 之前 —— 上游一次 400 要等一个来回，
  // 而我们本地就能判掉。这一条省的是时间，也是钱。
  const reason = checkModelSize(width, height)
  if (reason) {
    throw new HttpError('BAD_REQUEST',
      `图片尺寸 ${width}x${height} 不符合模型要求：${reason}`, 400)
  }

  // 业务层上限：长边 ≤ MAX_DIMENSION（2048，spec §4.4——出货客户端由
  // prepareForModel 钉着这个数）。checkModelSize 只管 API 的硬约束（4096），
  // 那是上游的底线，不是我们的策略：不设这道门，一个不老实或有 bug 的客户端
  // 就能让账户按 4096² 的账单付费。
  //
  // ⚠️ 故意**不放进 checkModelSize**：shared/size.test.ts 有一条测试钉住
  // 「4096 是 API 的上限，不是我们的」（checkModelSize(4096, 2048) === null）。
  const longSide = Math.max(width, height)
  if (longSide > MAX_DIMENSION) {
    throw new HttpError('BAD_REQUEST',
      `图片长边 ${longSide} 超过本服务的上限 ${MAX_DIMENSION}，请先缩图`, 400)
  }

  return { imageDataUrl, editPrompt, width, height }
}
