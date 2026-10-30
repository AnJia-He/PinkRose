import { isRawFileName } from '../../shared/imageFormats.ts'

type BrowserFile = File & { webkitRelativePath?: string }

export type RawPreviewPair = {
  raw: File
  preview: File
}

export type RawPreviewDedupe = {
  files: File[]
  pairs: RawPreviewPair[]
  skippedPreviews: File[]
}

function relativePath(file: File): string {
  const path = (file as BrowserFile).webkitRelativePath
  return path && path.trim() ? path : file.name
}

function groupKey(file: File): string {
  const path = relativePath(file).replace(/\\/g, '/')
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = path.slice(slash + 1)
  return `${dir}${name.replace(/\.[^.]+$/, '').toLowerCase()}`
}

function isPreview(file: Pick<File, 'name' | 'type'>): boolean {
  return /\.(?:jpe?g|heic|heif)$/i.test(file.name)
    || /^image\/(?:jpeg|heic|heif)$/i.test(file.type)
}

/**
 * 普通文件夹上传里的 RAW + 相机预览去重。
 *
 * 只在同一相对目录、同一 stem 恰好一张 RAW + 一张预览时合并；优先保留 RAW，
 * 因为完整解码器 / 内嵌预览还能继续工作，而 JPEG 只剩 8 位预览。多 RAW、
 * 多预览或不同目录时一律不猜，避免误删用户的选择。
 */
export function dedupeRawPreviews(files: readonly File[]): RawPreviewDedupe {
  const groups = new Map<string, {
    raws: { file: File; index: number }[]
    previews: { file: File; index: number }[]
  }>()
  files.forEach((file, index) => {
    const key = groupKey(file)
    const group = groups.get(key) ?? { raws: [], previews: [] }
    if (isRawFileName(file.name)) group.raws.push({ file, index })
    else if (isPreview(file)) group.previews.push({ file, index })
    groups.set(key, group)
  })

  const skip = new Set<number>()
  const pairs: RawPreviewPair[] = []
  const ordered: { file: File; order: number }[] = []
  const pairedIndexes = new Set<number>()
  for (const group of groups.values()) {
    if (group.raws.length !== 1 || group.previews.length !== 1) continue
    const raw = group.raws[0]!
    const preview = group.previews[0]!
    skip.add(preview.index)
    pairedIndexes.add(raw.index)
    pairs.push({ raw: raw.file, preview: preview.file })
    ordered.push({
      file: raw.file,
      order: Math.min(raw.index, preview.index),
    })
  }
  files.forEach((file, index) => {
    if (skip.has(index) || pairedIndexes.has(index)) return
    ordered.push({ file, order: index })
  })
  ordered.sort((a, b) => a.order - b.order)

  return {
    files: ordered.map(item => item.file),
    pairs,
    skippedPreviews: [...skip].sort((a, b) => a - b).map(index => files[index]!),
  }
}
