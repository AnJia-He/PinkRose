/** 前后端共用的照片容器识别。浏览器给 RAW 的 MIME 经常为空，扩展名是主判据。 */

export const RAW_EXTENSIONS = [
  '.dng', '.cr2', '.cr3', '.nef', '.nrw',
  '.arw', '.srf', '.sr2', '.raf', '.orf',
  '.rw2', '.rwl', '.raw', '.pef', '.srw',
  '.x3f', '.3fr', '.fff', '.iiq', '.mos',
  '.mrw', '.dcr', '.kdc', '.erf', '.mef',
  '.gpr',
] as const

export type ImageFileFormat = 'raw' | 'heic' | 'tiff'

const RAW_SET = new Set<string>(RAW_EXTENSIONS)

export const RAW_FILE_ACCEPT = RAW_EXTENSIONS.join(',')

export function normalizeImageExtension(ext: string): string {
  const lower = ext.trim().toLowerCase()
  if (!lower) return ''
  return lower.startsWith('.') ? lower : `.${lower}`
}

export function isRawExtension(ext: string): boolean {
  return RAW_SET.has(normalizeImageExtension(ext))
}

export function isRawFileName(name: string): boolean {
  const at = name.lastIndexOf('.')
  return at >= 0 && isRawExtension(name.slice(at))
}

export function isRawMime(type: string): boolean {
  return /^image\/(?:x-)?(?:adobe-dng|canon-cr[23]|nikon-nef|sony-arw|fuji-raf|olympus-orf|panasonic-rw2|pentax-pef|samsung-srw|sigma-x3f|hasselblad-(?:3fr|fff)|phaseone-iiq|leaf-mos|minolta-mrw|kodak-(?:dcr|kdc)|epson-erf|mamiya-mef|gopro-gpr)$/i
    .test(type)
}

export function imageFileFormat(name: string): ImageFileFormat | null {
  const at = name.lastIndexOf('.')
  if (at < 0) return null
  const ext = name.slice(at).toLowerCase()
  if (isRawExtension(ext)) return 'raw'
  if (ext === '.heic' || ext === '.heif') return 'heic'
  if (ext === '.tif' || ext === '.tiff') return 'tiff'
  return null
}
