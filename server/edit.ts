import type { EditRequest, EditResponse } from '../shared/protocol.ts'
import { checkModelSize } from '../shared/size.ts'
import { HttpError } from './http.ts'
import { buildEditPrompt } from './prompt.ts'
import type { SerialQueue } from './queue.ts'
import type { SenseNovaClient } from './sn.ts'

export type EditDeps = { client: SenseNovaClient; queue: SerialQueue }

export async function handleEdit(raw: unknown, deps: EditDeps): Promise<EditResponse> {
  const req = parseRequest(raw)
  const prompt = buildEditPrompt(req.editPrompt)

  const b64 = await deps.queue.run(() => deps.client.edit({
    imageDataUrl: req.imageDataUrl,
    prompt,
    size: { width: req.width, height: req.height },
  }), 'edit')

  return {
    imageDataUrl: `data:image/png;base64,${b64}`,
    width: req.width,
    height: req.height,
  }
}

function parseRequest(raw: unknown): EditRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError('BAD_REQUEST', '请求体必须是 JSON 对象', 400)
  }
  const o = raw as Record<string, unknown>

  const imageDataUrl = o.imageDataUrl
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    throw new HttpError('BAD_REQUEST', 'imageDataUrl 必须是 data:image/... 开头的 data URL', 400)
  }

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

  return { imageDataUrl, editPrompt, width, height }
}
