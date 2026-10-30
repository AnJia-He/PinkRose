/** HEIC 能力探测只返回一个小对象，和编码器分开打包。 */
export type HeicCapability = {
  available: boolean
  encoder: 'sips' | 'magick' | null
}

export async function getHeicCapability(
  doFetch: typeof fetch = fetch.bind(globalThis),
): Promise<HeicCapability> {
  try {
    const res = await doFetch('/api/convert/heic/capability', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok) return { available: false, encoder: null }
    const body = await res.json() as Partial<HeicCapability>
    return {
      available: body.available === true,
      encoder: body.encoder === 'sips' || body.encoder === 'magick'
        ? body.encoder
        : null,
    }
  } catch {
    return { available: false, encoder: null }
  }
}
