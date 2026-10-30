import { describe, expect, it } from 'vitest'
import {
  motionArgs, parseMotionRequest,
} from './motion.ts'

const onePixel = Buffer.from('jpeg-bytes').toString('base64')
const frame = `data:image/jpeg;base64,${onePixel}`

describe('照片视频请求', () => {
  it('接受 2–12 帧，并保留尺寸 / 帧时长', () => {
    const parsed = parseMotionRequest({
      frames: [frame, frame], width: 720, height: 900, frameMs: 800,
    })
    expect(parsed).toMatchObject({ width: 720, height: 900, frameMs: 800 })
    expect(parsed.frames).toHaveLength(2)
    expect(parsed.frames[0]!.toString()).toBe('jpeg-bytes')
  })

  it('拒绝少帧、奇数尺寸、错误格式和过短停留', () => {
    expect(() => parseMotionRequest({
      frames: [frame], width: 720, height: 720, frameMs: 800,
    })).toThrow(/至少/)
    expect(() => parseMotionRequest({
      frames: [frame, frame], width: 721, height: 720, frameMs: 800,
    })).toThrow(/偶数/)
    expect(() => parseMotionRequest({
      frames: [frame, frame], width: 720, height: 720, frameMs: 100,
    })).toThrow(/停留时间/)
    expect(() => parseMotionRequest({
      frames: [frame, 'data:image/png;base64,AAAA'], width: 720, height: 720, frameMs: 800,
    })).toThrow(/格式/)
  })

  it('ffmpeg 参数固定为 H.264、yuv420p、faststart 和 30fps', () => {
    const args = motionArgs(720, 900, 800, 'C:\\tmp\\motion')
    expect(args).toContain('libx264')
    expect(args).toContain('yuv420p')
    expect(args).toContain('+faststart')
    expect(args).toContain('30')
    expect(args.join(' ')).toContain('scale=720:900:flags=lanczos')
    expect(args.join(' ')).toContain('frame-%03d.jpg')
  })
})
