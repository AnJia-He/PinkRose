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
    reply: '这张旧照片有时间留下的痕迹，我先把划痕和噪点修干净，原来的质感都留住。',
    prompt:
      'Restore this old photograph: remove scratches, dust spots, creases, stains and mold; '
      + 'repair small missing details; reduce blur and noise; keep the original composition, '
      + 'the same person and facial identity, clothing, background and original colors; '
      + 'preserve natural skin texture; no beautification, no reshaping, no added objects, no text.',
  },
  {
    id: 'enhance',
    label: '画质增强',
    reply: '画面本身的内容已经在了，我把模糊、压缩噪点和小瑕疵收一收，不重画五官。',
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
    reply: '这张的轮廓和细节都还在，我按自然的肤色和环境光去上色，不凭空加东西。',
    prompt:
      'Colorize this black-and-white or faded historical photograph with natural colors: preserve '
      + 'the same person, facial features, expression, clothing, background, composition and all '
      + 'original detail. Use believable skin, fabric and environment colors; keep the original '
      + 'lighting and texture; no added objects, no text, no watermark.',
  },
  {
    id: 'erase',
    label: '消除路人',
    reply: '后面的人抢走了一些视线，我只清掉背景里的路人，主体、构图和海岸线都保持不动。',
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
    reply: '天空有点压住画面，我换成傍晚的柔和云层，前景和人物身上的光保持连贯。',
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
    reply: '这张的构图适合动画化，我保留人物和场景，只换线条和上色方式。',
    prompt:
      'Turn this photograph into a clean anime illustration: keep the same person, pose, '
      + 'facial identity, hairstyle, clothing and background composition; use crisp line art '
      + 'and soft cel shading; no extra characters, no text, no watermark.',
  },
  {
    id: 'sketch',
    label: '手绘化',
    reply: '这张的氛围适合手绘，我保留人物和构图，只换笔触和纸张质感。',
    prompt:
      'Turn this photograph into a soft hand-painted watercolor illustration: preserve the '
      + 'same person, pose, facial identity, clothing and background composition; use gentle '
      + 'brush strokes and natural paper texture; no extra objects, no text, no watermark.',
  },
  {
    id: 'studio',
    label: 'AI 写真',
    reply: '人像本身已经很完整，我只把背景收干净、把光理顺，脸和轮廓不动。',
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
    reply: '衣服这部分我来换，脸、姿态、发型和背景都保持原样。',
    prompt:
      'Change the clothing in this photograph to a tailored navy business suit with a white shirt. '
      + 'Keep the same person, facial identity, pose, body shape, hairstyle, background, camera angle '
      + 'and lighting; make the fabric and fit realistic; do not change the face or add new people, '
      + 'objects, text or watermark.',
  },
  {
    id: 'dewatermark',
    label: '去水印',
    reply: '水印确实容易分散注意，我把它和叠加文字清掉，画面里的主体不动。',
    prompt:
      'Remove only watermarks, logos, date stamps and overlaid text from this photograph. '
      + 'Fill the removed areas naturally from the surrounding texture and lighting. Keep the same '
      + 'person, objects, composition, colors and background completely unchanged; do not add or '
      + 'remove anything else; no new text or watermark.',
  },
  {
    id: 'hair',
    label: 'AI 发型',
    reply: '发型这块我来调整，脸、姿态和背景都保持原样。',
    prompt:
      'Change only the hairstyle in this photograph to a natural shoulder-length layered cut. '
      + 'Keep the same person, facial identity, pose, expression, clothing, background, camera angle '
      + 'and lighting; make the hairline, strands and volume realistic; do not change the face or add '
      + 'new people, objects, text or watermark.',
  },
  {
    id: 'beach',
    label: '海边背景',
    reply: '海边的光线更松弛，我只换背景，并把人物边缘和光向接上。',
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
    reply: '城市夜景更安静，我只换背景，人物的脸、衣服和现有机位不动。',
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
    reply: '雪景会让画面安静下来，我只换背景，人物和前景边缘都留着。',
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
    reply: '我把商品放进干净的白底里，商品本身的形状、材质和标签不动。',
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
