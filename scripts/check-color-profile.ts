import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDisplayP3IccProfile, createSrgbIccProfile,
  injectJpegIcc, injectPngIcc, injectWebpIcc,
} from '../src/export/colorProfile.ts'

const profile = createSrgbIccProfile()
const p3Profile = createDisplayP3IccProfile()
const dir = mkdtempSync(join(tmpdir(), 'pinkrose-color-'))
const jpegPath = join(dir, 'tagged.jpg')
const pngPath = join(dir, 'tagged.png')
const webpPath = join(dir, 'tagged.webp')
const p3JpegPath = join(dir, 'tagged-p3.jpg')
const p3PngPath = join(dir, 'tagged-p3.png')

try {
  const sourceJpeg = readFileSync(fileURLToPath(new URL('../test-photos/e2e_first_use.jpg', import.meta.url)))
  const taggedJpeg = await injectJpegIcc(new Blob([sourceJpeg], { type: 'image/jpeg' }), profile)
  writeFileSync(jpegPath, new Uint8Array(await taggedJpeg.arrayBuffer()))
  const taggedP3Jpeg = await injectJpegIcc(
    new Blob([sourceJpeg], { type: 'image/jpeg' }), p3Profile,
  )
  writeFileSync(p3JpegPath, new Uint8Array(await taggedP3Jpeg.arrayBuffer()))

  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZJx8AAAAASUVORK5CYII=',
    'base64',
  )
  const taggedPng = await injectPngIcc(new Blob([onePixelPng], { type: 'image/png' }), profile)
  writeFileSync(pngPath, new Uint8Array(await taggedPng.arrayBuffer()))
  const taggedP3Png = await injectPngIcc(
    new Blob([onePixelPng], { type: 'image/png' }), p3Profile,
  )
  writeFileSync(p3PngPath, new Uint8Array(await taggedP3Png.arrayBuffer()))

  // WebP 结构由单元测试覆盖；这里额外检查 RIFF 头与 ICCP 存在。
  const syntheticWebp = Uint8Array.from([
    82, 73, 70, 70, 18, 0, 0, 0, 87, 69, 66, 80,
    86, 80, 56, 76, 5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0,
  ])
  const taggedWebp = await injectWebpIcc(new Blob([syntheticWebp], { type: 'image/webp' }), profile)
  const webpBytes = new Uint8Array(await taggedWebp.arrayBuffer())
  const webpAscii = Buffer.from(webpBytes).toString('latin1')
  if (String.fromCharCode(...webpBytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...webpBytes.slice(8, 12)) !== 'WEBP'
    || !webpAscii.includes('ICCP')) {
    throw new Error(`WebP 没有写入 ICCP（${webpBytes.length} bytes: ${JSON.stringify(webpAscii.slice(0, 48))}）`)
  }
  writeFileSync(webpPath, webpBytes)

  const pythonCode = `
import sys
from io import BytesIO
from PIL import Image, ImageCms

jpg, png, p3_jpg, p3_png = sys.argv[1:5]
for path in (jpg, png, p3_jpg, p3_png):
    im = Image.open(path)
    raw = im.info.get('icc_profile')
    if not raw:
        raise SystemExit(f'{path}: missing ICC profile')
    profile = ImageCms.getOpenProfile(BytesIO(raw))
    description = ImageCms.getProfileDescription(profile).strip()
    if path in (p3_jpg, p3_png) and 'Display P3' not in description:
        raise SystemExit(f'{path}: expected Display P3, got {description}')
    print(f'{path}: {description}')
`
  let python = spawnSync(
    'python',
    ['-c', pythonCode, jpegPath, pngPath, p3JpegPath, p3PngPath],
    { encoding: 'utf8' },
  )
  if (python.error && (python.error as NodeJS.ErrnoException).code === 'ENOENT') {
    python = spawnSync(
      'python3',
      ['-c', pythonCode, jpegPath, pngPath, p3JpegPath, p3PngPath],
      { encoding: 'utf8' },
    )
  }

  if (python.status !== 0) {
    process.stderr.write(python.stderr || python.stdout || 'Pillow ICC 检查失败\n')
    process.exitCode = 1
  } else {
    process.stdout.write(python.stdout)
    console.log(
      `✅ ICC 写入与独立解析通过：sRGB ${profile.length} bytes / Display P3 ${p3Profile.length} bytes，`
      + 'JPG / PNG / WebP 三种容器',
    )
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
