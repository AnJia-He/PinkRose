import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { readPhotoInfo, type PhotoInfo } from '../core/photoInfo'

type Props = {
  file: File | null
  width: number
  height: number
}

/**
 * 「照片信息」按需展开：打开时才读 EXIF，关闭时不占解析成本。
 * 只在本机解析文件，不把原图或拍摄信息发到服务端。
 */
export default function PhotoInfoPanel({ file, width, height }: Props) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<PhotoInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!open || !file) return
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    void readPhotoInfo(file, width, height).then(
      next => {
        if (seq !== seqRef.current) return
        setInfo(next)
        setLoading(false)
      },
      () => {
        if (seq !== seqRef.current) return
        setError('这张照片的信息没读出来，画面不受影响。')
        setLoading(false)
      },
    )
    return () => { seqRef.current++ }
  }, [open, file, width, height])

  const detail = (label: string, value: string | null) => value ? (
    <div className="photo-info-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  ) : null

  return (
    <>
      <button
        type="button"
        className="crop-chip"
        disabled={!file}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Info size={14} strokeWidth={1.5} aria-hidden="true" />
        照片信息
      </button>
      {open && (
        <div className="photo-info" role="region" aria-label="照片信息">
          {loading && <p className="photo-info-note" aria-live="polite">正在读取照片信息…</p>}
          {!loading && error && <p className="photo-info-note">{error}</p>}
          {!loading && !error && info && (
            <>
              <dl>
                <div className="photo-info-row">
                  <dt>文件</dt>
                  <dd title={info.fileName}>{info.fileName}</dd>
                </div>
                {detail('文件大小', info.fileSize)}
                {detail('尺寸', `${info.width} × ${info.height}`)}
                {detail('类型', info.fileType)}
                {detail('相机', info.camera)}
                {detail('镜头', info.lens)}
                {detail('拍摄时间', info.takenAt)}
                {detail('快门', info.shutter)}
                {detail('光圈', info.aperture)}
                {detail('感光度', info.iso)}
                {detail('焦距', info.focalLength)}
                {detail('白平衡', info.whiteBalance)}
                {detail('作者', info.creator)}
                {detail('版权', info.copyright)}
                {detail('位置', info.gps)}
                {detail('色彩配置', info.colorProfile)}
              </dl>
              {!info.hasExif && (
                <p className="photo-info-note">这张格式没有可读的拍摄信息，只显示文件与尺寸。</p>
              )}
              {info.hasGps && (
                <p className="photo-info-note">照片含 GPS 位置信息；导出时会按「保留拍摄信息」设置处理。</p>
              )}
              <p className="photo-info-note">拍摄信息只在本机读取，不会上传。</p>
            </>
          )}
        </div>
      )}
    </>
  )
}
