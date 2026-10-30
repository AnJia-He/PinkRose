import { buildZipBlob } from '../batch/zip'
import { buildFilename, type ExportOptions } from './save'
import { PLATFORM_PRESETS } from './platforms'

export type SocialExportResult = {
  blob: Blob
  name: string
  count: number
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * 同一张照片一次生成常用平台的 JPG 尺寸，并打包成一个 ZIP。
 * 水印与图层由调用方的 render 负责；这里只定义平台参数和 ZIP 包装。
 */
export async function buildSocialExportZip(
  originalFile: File,
  base: ExportOptions,
  render: (options: ExportOptions) => Promise<Blob>,
  customStem = '',
): Promise<SocialExportResult> {
  const entries: { name: string; data: Uint8Array<ArrayBuffer> }[] = []
  const stem = buildFilename(originalFile.name, 'image/jpeg', customStem).replace(/\.jpg$/i, '')
  for (const preset of PLATFORM_PRESETS) {
    const blob = await render({
      ...base,
      format: 'image/jpeg',
      qualityPct: preset.qualityPct,
      longEdge: preset.longEdge,
      aspect: preset.aspect,
      fit: 'crop',
    })
    entries.push({
      name: `${stem}-${preset.id}.jpg`,
      data: await blobBytes(blob),
    })
  }
  return {
    blob: buildZipBlob(entries),
    name: `${stem}_社交尺寸.zip`,
    count: entries.length,
  }
}
