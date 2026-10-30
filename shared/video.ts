/**
 * 短片调色的**共用常量**（★ 2026-10-20）—— 前后端各算一遍同一个上限，
 * 数字只写一处：浏览器超了会提前拦住，服务端超了会回 400，两处说同一句话。
 */

/** 一段短片最长能修多少秒。 */
export const VIDEO_MAX_SECONDS = 20

/** 太短的话连一个完整节拍都没有，导出没有意义。 */
export const VIDEO_MIN_SECONDS = 0.5

/** 可选帧率。12 = 省电/大文件也能修；24 = 默认，接近电影感。 */
export const VIDEO_FPS_OPTIONS = [12, 24] as const

/** 输出长边上限（像素）。 */
export const VIDEO_MAX_LONG_EDGE = 1280

/**
 * 成片画幅。`source` = 跟原片一样；其余按中心裁切到目标比例。
 * 比例放在这里，是因为界面上的选项和导出时的尺寸必须认同一份定义。
 */
export const VIDEO_ASPECTS = [
  { id: 'source', label: '原比例' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '9:16', label: '9:16' },
  { id: '16:9', label: '16:9' },
] as const

export type VideoAspect = (typeof VIDEO_ASPECTS)[number]['id']

/** 一帧 JPEG 的字节上限。 */
export const VIDEO_MAX_FRAME_BYTES = 2 * 1024 * 1024

/** 一次上传多少帧。 */
export const VIDEO_FRAME_BATCH = 8

/** 一个会话最多收多少帧（20 秒 24fps = 480，留一点余量给帧率换算）。 */
export const VIDEO_MAX_TOTAL_FRAMES = 600

/** 源视频文件上限（本机局域网传，给足 4K 手机拍摄的余量）。 */
export const VIDEO_MAX_SOURCE_BYTES = 512 * 1024 * 1024

/** 一次最多拼几段。再多就不像"修图"了，也超过手机端逐帧渲染的耐心。 */
export const VIDEO_MAX_CLIPS = 6
