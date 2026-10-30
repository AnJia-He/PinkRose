export type AiPresetId =
  | 'restore' | 'enhance' | 'colorize'
  | 'erase' | 'sky' | 'anime' | 'sketch'
  | 'studio' | 'outfit' | 'dewatermark' | 'hair'
  | 'beach' | 'city-night' | 'snow' | 'product-white'

export type AiPreset = {
  id: AiPresetId
  label: string
  prompt: string
  reply: string
}

/**
 * 一键 AI 预设：固定标签 / 提示词 / 应答只留一份。
 *
 * 这些提示词都把「保留」写满：构图、同一个人、五官、服装、背景和原色。
 * 修复额外要求去划痕 / 灰尘 / 折痕 / 污渍、补小缺口和降噪；
 * 画质增强只修压缩噪点 / 模糊 / 清晰度，黑白上色只补自然颜色；
 * 消除路人只清背景里的 incidental people，明确不许动主体、也不许补新的人；
 * 换天空只改天空，前景、透视和原有光照方向都保留；
 * 动漫 / 手绘只改画风，不换人、不加物、不加字。
 */
export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: 'restore',
    label: '修复老照片',
    reply: '好，这就修复这张老照片。',
    prompt:
      'Restore this old photograph: remove scratches, dust spots, creases, stains and mold; '
      + 'repair small missing details; reduce blur and noise; keep the original composition, '
      + 'the same person and facial identity, clothing, background and original colors; '
      + 'preserve natural skin texture; no beautification, no reshaping, no added objects, no text.',
  },
  {
    id: 'enhance',
    label: '画质增强',
    reply: '好，这就把清晰度和噪点修一下。',
    prompt:
      'Enhance image quality without changing the scene: reduce compression artifacts and noise, '
      + 'recover fine detail, improve edge sharpness and correct slight blur while preserving natural '
      + 'skin texture. Keep the same person and facial identity, pose, expression, clothing, background, '
      + 'composition, lighting and colors; no beautification, no reshaping, no added objects, no text, '
      + 'no watermark.',
  },
  {
    id: 'colorize',
    label: '黑白上色',
    reply: '好，这就给这张黑白照片上色。',
    prompt:
      'Colorize this black-and-white or faded historical photograph with natural colors: preserve '
      + 'the same person, facial features, expression, clothing, background, composition and all '
      + 'original detail. Use believable skin, fabric and environment colors; keep the original '
      + 'lighting and texture; no added objects, no text, no watermark.',
  },
  {
    id: 'erase',
    label: '消除路人',
    reply: '好，这就把画面里的路人去掉。',
    prompt:
      'Remove only incidental people, tourists and photobombers in the background of this photograph. '
      + 'Fill the vacated areas naturally from the surrounding background and lighting. Keep the main subject '
      + 'completely unchanged, including pose, facial identity, hairstyle, clothing and expression; preserve '
      + 'the original composition, architecture, colors and realistic texture; do not add any new people, '
      + 'objects, text or watermark.',
  },
  {
    id: 'sky',
    label: '换天空',
    reply: '好，这就把天空换成傍晚的。',
    prompt:
      'Replace only the sky in this photograph with a natural golden-hour sky and soft clouds. '
      + 'Keep the foreground, people, buildings, trees, ground and water completely unchanged, '
      + 'including identity, pose, clothing, composition and camera perspective. Match the new '
      + 'sky\'s light direction and color to the existing scene; preserve realistic reflections '
      + 'and shadows; no added objects, no text, no watermark.',
  },
  {
    id: 'anime',
    label: '动漫化',
    reply: '好，这就换成动漫风。',
    prompt:
      'Turn this photograph into a clean anime illustration: keep the same person, pose, '
      + 'facial identity, hairstyle, clothing and background composition; use crisp line art '
      + 'and soft cel shading; no extra characters, no text, no watermark.',
  },
  {
    id: 'sketch',
    label: '手绘化',
    reply: '好，这就换手绘风。',
    prompt:
      'Turn this photograph into a soft hand-painted watercolor illustration: preserve the '
      + 'same person, pose, facial identity, clothing and background composition; use gentle '
      + 'brush strokes and natural paper texture; no extra objects, no text, no watermark.',
  },
  {
    id: 'studio',
    label: 'AI 写真',
    reply: '好，这就给你做一张干净的人像写真。',
    prompt:
      'Create a polished professional studio portrait from this photograph. Keep the same person, '
      + 'facial identity, pose, expression, hairstyle, body shape and clothing; replace only the '
      + 'background with a clean neutral studio backdrop; use soft key light, subtle rim light, '
      + 'natural skin texture and realistic color; no beautification, no reshaping, no extra people, '
      + 'no text, no watermark.',
  },
  {
    id: 'outfit',
    label: 'AI 换装',
    reply: '好，这就把衣服换成一套干净的深蓝西装。',
    prompt:
      'Change the clothing in this photograph to a tailored navy business suit with a white shirt. '
      + 'Keep the same person, facial identity, pose, body shape, hairstyle, background, camera angle '
      + 'and lighting; make the fabric and fit realistic; do not change the face or add new people, '
      + 'objects, text or watermark.',
  },
  {
    id: 'dewatermark',
    label: '去水印',
    reply: '好，这就把画面上的水印、Logo 和叠加文字去掉。',
    prompt:
      'Remove only watermarks, logos, date stamps and overlaid text from this photograph. '
      + 'Fill the removed areas naturally from the surrounding texture and lighting. Keep the same '
      + 'person, objects, composition, colors and background completely unchanged; do not add or '
      + 'remove anything else; no new text or watermark.',
  },
  {
    id: 'hair',
    label: 'AI 发型',
    reply: '好，这就换成自然的齐肩层次发型。',
    prompt:
      'Change only the hairstyle in this photograph to a natural shoulder-length layered cut. '
      + 'Keep the same person, facial identity, pose, expression, clothing, background, camera angle '
      + 'and lighting; make the hairline, strands and volume realistic; do not change the face or add '
      + 'new people, objects, text or watermark.',
  },
  {
    id: 'beach',
    label: '海边背景',
    reply: '好，这就把背景换成自然的海边。',
    prompt:
      'Replace only the background behind the main subject with a natural sunny beach scene, '
      + 'including soft ocean waves, warm sand and a clear sky. Keep the same person, facial identity, '
      + 'pose, expression, hairstyle, body shape and clothing completely unchanged; preserve the '
      + 'foreground edges, composition and camera angle. Match the new background lighting, shadows '
      + 'and perspective to the subject; no extra people, objects, text or watermark.',
  },
  {
    id: 'city-night',
    label: '城市夜景',
    reply: '好，这就把背景换成城市夜景。',
    prompt:
      'Replace only the background behind the main subject with a realistic city night scene, '
      + 'with distant buildings, warm street lights and soft bokeh. Keep the same person, facial '
      + 'identity, pose, expression, clothing, foreground and composition unchanged; match the '
      + 'light direction and color temperature to the subject; preserve natural skin texture and '
      + 'realistic edges; no extra people, text or watermark.',
  },
  {
    id: 'snow',
    label: '雪景',
    reply: '好，这就把背景换成安静的雪景。',
    prompt:
      'Replace only the background behind the main subject with a quiet winter snow scene, '
      + 'with soft falling snow, distant trees and cool natural daylight. Keep the same person, '
      + 'facial identity, pose, expression, hairstyle, clothing, foreground and composition '
      + 'unchanged; match the lighting and shadows to the subject; no extra people, objects, '
      + 'text or watermark.',
  },
  {
    id: 'product-white',
    label: '商品白底',
    reply: '好，这就把商品背景换成干净的纯白棚拍。',
    prompt:
      'Replace only the background behind the main product with a clean seamless white studio '
      + 'backdrop. Keep the product shape, color, material, labels, logo, reflections and fine '
      + 'details completely unchanged; preserve the original camera angle and perspective; add a '
      + 'subtle natural contact shadow so the product sits believably; no extra objects, text or watermark.',
  },
]

export function aiPreset(id: AiPresetId): AiPreset {
  return AI_PRESETS.find(p => p.id === id)!
}
