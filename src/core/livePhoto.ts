/**
 * Apple Live Photo 的文件配对。
 *
 * 浏览器拿不到相册里的“一张 Live Photo 对象”，但用户从文件系统 / iCloud
 * 导出时通常得到一对同名文件，例如 `IMG_1001.HEIC` + `IMG_1001.MOV`。
 * 这里只认这种明确的一对一关系，不根据时间、顺序或相似度猜。
 */
export type LivePhotoPair = {
  image: File
  movie: File
}

export type LivePhotoEvidence = {
  status: 'verified' | 'unverified' | 'mismatch'
  detail: string
  movieId: string | null
  imageId: string | null
}

const IMAGE_RE = /\.(?:heic|heif|jpe?g)$/i
const MOVIE_RE = /\.mov$/i
const CONTENT_KEY = 'com.apple.quicktime.content.identifier'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEAD_BYTES = 4 * 1024 * 1024
const TAIL_BYTES = 12 * 1024 * 1024

export function isLivePhotoImage(file: Pick<File, 'name' | 'type'>): boolean {
  return IMAGE_RE.test(file.name) || /^image\/(?:heic|heif|jpeg)$/i.test(file.type)
}

export function isLivePhotoMovie(file: Pick<File, 'name' | 'type'>): boolean {
  return MOVIE_RE.test(file.name) || file.type === 'video/quicktime'
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

/**
 * 把一批文件按同名 stem 分成实况照片组。每组必须恰好一张照片和一个 MOV；
 * 同 stem 出现两张照片或两个 MOV 时无法判断该配哪一张，整组放弃，不猜。
 */
export function pairLivePhotos(files: readonly File[]): LivePhotoPair[] {
  const images = new Map<string, File[]>()
  const movies = new Map<string, File[]>()
  for (const file of files) {
    const key = stem(file.name)
    if (!key) continue
    if (isLivePhotoImage(file)) {
      images.set(key, [...(images.get(key) ?? []), file])
    } else if (isLivePhotoMovie(file)) {
      movies.set(key, [...(movies.get(key) ?? []), file])
    }
  }
  const pairs: LivePhotoPair[] = []
  for (const [key, groupImages] of images) {
    const groupMovies = movies.get(key) ?? []
    if (groupImages.length === 1 && groupMovies.length === 1) {
      pairs.push({ image: groupImages[0]!, movie: groupMovies[0]! })
    }
  }
  return pairs.sort((a, b) => stem(a.image.name).localeCompare(stem(b.image.name)))
}

/** 兼容只处理一组调用方：恰好一对才返回，否则交给多组入口。 */
export function pairLivePhoto(files: readonly File[]): LivePhotoPair | null {
  if (files.length !== 2) return null
  const pairs = pairLivePhotos(files)
  return pairs.length === 1 ? pairs[0]! : null
}

function latin1(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    out += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return out
}

function firstUuid(text: string): string | null {
  UUID_RE.lastIndex = 0
  return text.match(UUID_RE)?.[0]?.toLowerCase() ?? null
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  outer: for (let at = 0; at <= haystack.length - needle.length; at++) {
    for (let i = 0; i < needle.length; i++) {
      if (haystack[at + i] !== needle[i]) continue outer
    }
    return true
  }
  return false
}

/**
 * MOV 的 Content Identifier 住在 QuickTime metadata 的 keys / ilst 里。
 * 这里先认标准 key，再在附近取 UUID；没有 key 的普通 MOV 不会被时间或文件名
 * 冒充成 Apple 实况照片。
 */
export function movieContentIdentifier(bytes: Uint8Array): string | null {
  const text = latin1(bytes).toLowerCase()
  const keyAt = text.indexOf(CONTENT_KEY)
  if (keyAt < 0) return null
  return firstUuid(text.slice(keyAt + CONTENT_KEY.length, keyAt + CONTENT_KEY.length + 8192))
}

/** 静帧里常见的是 Apple MakerNote 的 ASCII UUID；HEIC 也可能写 16 字节原值。 */
export function imageContentIdentifier(bytes: Uint8Array): string | null {
  return firstUuid(latin1(bytes))
}

/**
 * 先看静帧是否也写了同一个文本 UUID；若静帧只写了 Apple MakerNote 的 16 字节
 * 原值，则直接用 MOV 的 UUID 去字节里找。两者都找不到时只标「未核对」，不误判。
 */
export function inspectLivePhotoBytes(
  image: Uint8Array,
  movie: Uint8Array,
): LivePhotoEvidence {
  const movieId = movieContentIdentifier(movie)
  if (!movieId) {
    return {
      status: 'unverified',
      detail: 'MOV 没有可核对的 Apple 实况标识；当前仅按同名配对。',
      movieId: null,
      imageId: imageContentIdentifier(image),
    }
  }
  const imageId = imageContentIdentifier(image)
  if (imageId) {
    if (imageId === movieId) {
      return {
        status: 'verified',
        detail: '照片和 MOV 的 Apple 实况标识一致。',
        movieId,
        imageId,
      }
    }
    return {
      status: 'mismatch',
      detail: '文件名相同，但照片和 MOV 的 Apple 实况标识不一致；它们可能不是同一张实况照片。',
      movieId,
      imageId,
    }
  }
  if (includesBytes(image, uuidBytes(movieId))) {
    return {
      status: 'verified',
      detail: '照片里的 Apple 实况标识与 MOV 一致。',
      movieId,
      imageId: movieId,
    }
  }
  return {
    status: 'unverified',
    detail: '静帧里没有找到可核对的实况标识；当前仅按同名配对。',
    movieId,
    imageId: null,
  }
}

async function evidenceBytes(file: File): Promise<Uint8Array> {
  const read = async (blob: Blob): Promise<Uint8Array<ArrayBuffer>> => {
    if (typeof blob.arrayBuffer === 'function') {
      return new Uint8Array(await blob.arrayBuffer())
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error ?? new Error('读取实况照片失败'))
      reader.readAsArrayBuffer(blob)
    })
  }
  if (file.size <= HEAD_BYTES + TAIL_BYTES) return read(file)
  const head = await read(file.slice(0, HEAD_BYTES))
  const tail = await read(file.slice(Math.max(0, file.size - TAIL_BYTES)))
  const out = new Uint8Array(head.length + tail.length)
  out.set(head)
  out.set(tail, head.length)
  return out
}

/** 只读第一段和最后一段，EXIF 通常在文件头、QuickTime moov 常在文件尾。 */
export async function inspectLivePhotoPair(pair: LivePhotoPair): Promise<LivePhotoEvidence> {
  const [image, movie] = await Promise.all([
    evidenceBytes(pair.image),
    evidenceBytes(pair.movie),
  ])
  return inspectLivePhotoBytes(image, movie)
}
