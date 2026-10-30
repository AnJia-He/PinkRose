import type { FaceBox } from '../core/faceDetect'

/**
 * 人像工具的人脸框提示：只让人看见「脸认在这里」，不挡指针、不参与成片。
 * 坐标从图片像素换到照片可见矩形，缩放 / 平移时跟照片一起动。
 */
export default function FaceGuide(props: {
  box: { left: number; top: number; width: number; height: number }
  imageWidth: number
  imageHeight: number
  face: FaceBox
  label?: string
  active?: boolean
  onPick?: () => void
}) {
  const { box, imageWidth, imageHeight, face, label = '人脸', active, onPick } = props
  const sx = box.width / Math.max(1, imageWidth)
  const sy = box.height / Math.max(1, imageHeight)
  const style = {
    left: box.left + face.x * sx,
    top: box.top + face.y * sy,
    width: face.w * sx,
    height: face.h * sy,
  }
  const content = (
    <>
      <span className="face-guide-label">{label}</span>
    </>
  )
  if (!onPick) return <div className="face-guide" style={style}>{content}</div>
  return (
    <button
      type="button"
      className={`face-guide face-guide-pick${active ? ' on' : ''}`}
      style={style}
      aria-label={`选择${label}`}
      aria-pressed={active}
      onClick={onPick}
    >{content}</button>
  )
}
