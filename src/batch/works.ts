import { fullUrl } from '../api/works'
import { workName, type WorkMeta } from '../../shared/works.ts'
import { buildZipBlob, type ZipEntry } from './zip'
import { blobToDataUrl } from '../image/blob'

export const MAX_WORK_DOWNLOAD = 50

export type WorkDownloadProgress = {
  completed: number
  total: number
  currentName: string
}

export type WorkDownloadResult = {
  archive: Blob | null
  archiveName: string
  succeeded: number
  failures: { id: number; name: string; message: string }[]
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function worksArchiveName(now = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-works-${stamp}.zip`
}

function extOf(blob: Blob): string {
  if (blob.type === 'image/png') return 'png'
  if (blob.type === 'image/webp') return 'webp'
  if (blob.type === 'image/avif') return 'avif'
  if (blob.type === 'image/heic') return 'heic'
  if (blob.type === 'image/tiff') return 'tif'
  return 'jpg'
}

function safeStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '作品'
}

function uniqueName(stem: string, ext: string, used: Set<string>): string {
  let name = `${stem}.${ext}`
  let n = 2
  while (used.has(name.toLowerCase())) name = `${stem}_${n++}.${ext}`
  used.add(name.toLowerCase())
  return name
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  // Older embedded browsers / jsdom do not ship Blob.arrayBuffer.
  const dataUrl = await blobToDataUrl(blob)
  const binary = atob(dataUrl.split(',')[1] ?? '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 把选中的作品原图打包成一个 ZIP。单张取不到不终止整批：
 * 成功的照常打包，失败的在结果里如实列出来。
 */
export async function downloadWorksZip(
  works: readonly WorkMeta[],
  onProgress: (progress: WorkDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<WorkDownloadResult> {
  if (works.length === 0) throw new Error('先选几张作品')
  if (works.length > MAX_WORK_DOWNLOAD) throw new Error(`一次最多下载 ${MAX_WORK_DOWNLOAD} 张`)

  const now = new Date()
  const entries: ZipEntry[] = []
  const failures: WorkDownloadResult['failures'] = []
  const used = new Set<string>()
  onProgress({ completed: 0, total: works.length, currentName: workName(works[0]!, now.getTime()) })

  for (let i = 0; i < works.length; i++) {
    if (signal?.aborted) break
    const work = works[i]!
    const name = workName(work, now.getTime())
    onProgress({ completed: i, total: works.length, currentName: name })
    try {
      const response = await fetch(fullUrl(work), { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const data = await blobBytes(blob)
      entries.push({ name: uniqueName(safeStem(name), extOf(blob), used), data })
    } catch (e) {
      failures.push({
        id: work.id,
        name,
        message: e instanceof Error ? e.message : '取不到这张',
      })
    }
    onProgress({ completed: i + 1, total: works.length, currentName: name })
  }

  return {
    archive: entries.length > 0 ? buildZipBlob(entries) : null,
    archiveName: worksArchiveName(now),
    succeeded: entries.length,
    failures,
  }
}
