/**
 * Apple 实况照片的“成片 + 原动作”兼容包。
 *
 * Web 没有标准接口把静帧和 MOV 重新封装成 Apple 原生 Live Photo；这里只把
 * 当前导出的 JPG 和用户选的原始 MOV 放进同一个 ZIP，并让两者使用同一文件名
 * 词干。它在 Apple 设备上仍是两个文件，不冒充原生 Live Photo。
 */
import { buildZipBlob } from '../batch/zip'

export type LivePhotoBundleResult = {
  blob: Blob
  name: string
  imageName: string
  movieName: string
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
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

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * `imageName` 必须是已经准备好的 JPG 文件名；MOV 只换同名 stem，扩展名仍用
 * 原文件，不转码动作短片。
 */
export async function buildLivePhotoBundle(
  image: Blob,
  imageName: string,
  movie: File,
): Promise<LivePhotoBundleResult> {
  if (image.type !== 'image/jpeg') {
    throw new Error('实况照片兼容包需要 JPG 静帧')
  }
  const base = stem(imageName)
  const movieExt = movie.name.match(/\.mov$/i)?.[0] ?? '.mov'
  const movieName = `${base}${movieExt}`
  const entries = await Promise.all([
    blobBytes(image).then(data => ({ name: imageName, data })),
    blobBytes(movie).then(data => ({ name: movieName, data })),
  ])
  return {
    blob: buildZipBlob(entries),
    name: `${base}_实况照片兼容包.zip`,
    imageName,
    movieName,
  }
}
