/**
 * **短片导出的会话层**（★ 2026-10-20）。
 *
 * 「短片调色」和「照片电影」都要走同一条服务端链路：
 * 开会话 → 传源片 / 音乐 → 分批传帧 → 收尾编码 → 拿回 MP4。
 * 抽在这里，两边都不用各写一遍错误文案和分批规则。
 */

export type VideoSessionHandle = { id: string; baseUrl: string }

type FetchLike = typeof fetch

async function readError(res: Response, fallback: string): Promise<Error> {
  const detail = await res.json().catch(() => null) as
    { error?: unknown; message?: unknown; code?: unknown } | null
  const message = typeof detail?.message === 'string' ? detail.message
    : typeof detail?.error === 'string' ? detail.error
      : null
  // 别把对象直接塞进 Error（会变成 "[object Object]"）；带上 code 方便排查。
  const code = typeof detail?.code === 'string' ? `（${detail.code}）` : ''
  return new Error(message ?? `${fallback}${code}`)
}

export async function openVideoSession(doFetch: FetchLike = fetch): Promise<VideoSessionHandle> {
  const res = await doFetch('/api/video/session', {
    method: 'POST', credentials: 'same-origin',
  })
  if (!res.ok) throw new Error('开不了这次导出，刷新一下再试。')
  const { id } = await res.json() as { id?: string }
  if (!id) throw new Error('开不了这次导出，刷新一下再试。')
  return { id, baseUrl: `/api/video/session/${id}` }
}

export async function deleteVideoSession(
  handle: VideoSessionHandle, doFetch: FetchLike = fetch,
): Promise<void> {
  await doFetch(handle.baseUrl, {
    method: 'DELETE', credentials: 'same-origin',
  }).catch(() => {})
}

export async function uploadVideoSource(
  handle: VideoSessionHandle, index: number, file: Blob, doFetch: FetchLike = fetch,
  message = '源视频没传上去，再试一次。',
): Promise<void> {
  const res = await doFetch(`${handle.baseUrl}/source?index=${index}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw await readError(res, message)
}

export async function uploadVideoMusic(
  handle: VideoSessionHandle, file: Blob, doFetch: FetchLike = fetch,
): Promise<void> {
  const res = await doFetch(`${handle.baseUrl}/music`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw await readError(res, '背景音乐没传上去，再试一次。')
}

export async function uploadVideoFrames(
  handle: VideoSessionHandle, startIndex: number, frames: readonly string[],
  doFetch: FetchLike = fetch,
): Promise<void> {
  const res = await doFetch(`${handle.baseUrl}/frames`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startIndex, frames }),
  })
  if (!res.ok) throw await readError(res, '帧没传完，再试一次。')
}

export type VideoFinishBody = {
  clips: { startMs: number; durationMs: number }[]
  width: number
  height: number
  fps: number
  keepAudio: boolean
  music: { mode: 'mix' | 'replace'; volume: number } | null
}

export async function finishVideoSession(
  handle: VideoSessionHandle, body: VideoFinishBody, doFetch: FetchLike = fetch,
): Promise<Blob> {
  const res = await doFetch(`${handle.baseUrl}/finish`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res, '短片没编出来，再试一次。')
  return res.blob()
}
