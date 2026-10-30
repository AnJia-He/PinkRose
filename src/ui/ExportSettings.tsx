import { useRef, useState } from 'react'
import type {
  ExportAspect, ExportColorSpace, ExportFit, ExportFormat, ExportOptions,
} from '../export/save'
import type { WatermarkLogo, WatermarkOptions } from '../image/watermark'
import { PLATFORM_PRESETS } from '../export/platforms'
import { supportsEmbeddedColorProfile } from '../export/colorProfile'
import WatermarkControls from './WatermarkControls'

/**
 * 「把图给我」旁边的**导出设置**（★ 2026-10-17）。
 *
 * 主按钮仍然是「下载 / 分享」—— 不点这一下也能按默认值（JPG 95% 原尺寸）
 * 一键拿走。这一块只给需要控制格式、压缩率和尺寸的人：
 *   · JPG / PNG / WebP；
 *   · JPG / WebP 的质量 60~100（PNG 无损，不显示质量）；
 *   · 原图 / 长边 2048 / 长边 1080。
 *
 * ⚠️ 用 `<details>` 而不是自制弹出层：键盘、Esc、点外面收起都是浏览器给的。
 * ⚠️ 选项用 radio/range 而不是按钮：`TopActions` 外面那排 `.actions button`
 *   是测试和探针的锚点，不能因为这里多几个选项就把"这张照片怎么办"那三颗
 *   数成六颗。
 */
export default function ExportSettings(props: {
  options: ExportOptions
  onFormat: (format: ExportFormat) => void
  onQuality: (qualityPct: number) => void
  onLongEdge: (longEdge: number | null) => void
  onAspect?: (aspect: ExportAspect) => void
  onFit?: (fit: ExportFit) => void
  onMetadata?: (keep: boolean) => void
  onLocation?: (keep: boolean) => void
  onCreator?: (value: string) => void
  onCopyright?: (value: string) => void
  onColorSpace?: (colorSpace: ExportColorSpace) => void
  /** 单张导出的自定义文件名；留空 = 原文件名_pinkrose。 */
  filename?: string
  onFilename?: (name: string) => void
  /** 把当前这套格式 / 质量 / 尺寸 / 比例存成这台设备的默认值。 */
  onSaveDefaults?: () => void
  copySupported?: boolean
  onCopy?: () => Promise<void>
  /** 一次生成所有“常用平台”尺寸并打包。 */
  onExportPlatforms?: () => Promise<void>
  watermark?: WatermarkOptions
  watermarkLogo?: WatermarkLogo | null
  onWatermark?: (next: WatermarkOptions) => void
  onWatermarkLogo?: (file: File | null) => Promise<void> | void
  /** 服务端确认本机有 HEIC 编码器时才出现这个选项。 */
  heicSupported?: boolean
  /** 当前编辑的静帧来自一组 Apple 实况照片时，显示兼容包导出。 */
  livePhoto?: {
    status: 'checking' | 'verified' | 'unverified' | 'mismatch'
    detail: string
  } | null
  onExportLivePhoto?: (mode: 'download' | 'share') => Promise<void>
  /** 设备确认能通过系统面板分享 ZIP 时才出现额外入口。 */
  canShareArchive?: boolean
}) {
  const { options } = props
  const lossy = options.format === 'image/jpeg'
    || options.format === 'image/webp'
    || options.format === 'image/avif'
    || options.format === 'image/heic'
  const keepsMetadata = options.format === 'image/jpeg'
    || options.format === 'image/png'
    || options.format === 'image/webp'
    || options.format === 'image/tiff'
  const [copying, setCopying] = useState(false)
  const [packingPlatforms, setPackingPlatforms] = useState(false)
  const [exportingLive, setExportingLive] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const exportLive = async (mode: 'download' | 'share') => {
    setExportingLive(true)
    try { await props.onExportLivePhoto?.(mode) } finally {
      setExportingLive(false)
    }
  }
  return (
    <details ref={detailsRef} className="export-settings">
      <summary>导出设置</summary>
      <div className="export-sheet">
        <button
          type="button"
          className="crop-chip export-sheet-close"
          onClick={() => { if (detailsRef.current) detailsRef.current.open = false }}
        >收起</button>
        <div className="export-row" role="group" aria-label="导出格式">
          <span className="export-label">格式</span>
          {([
            ['image/jpeg', 'JPG'],
            ['image/png', 'PNG'],
            ['image/webp', 'WebP'],
            ['image/avif', 'AVIF'],
            ['image/tiff', 'TIFF'],
            ...(props.heicSupported ? [['image/heic', 'HEIC'] as const] : []),
          ] as const).map(([value, label]) => (
            <label key={value} className={`export-choice${options.format === value ? ' on' : ''}`}>
              <input
                type="radio"
                name="export-format"
                value={value}
                checked={options.format === value}
                onChange={() => props.onFormat(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {props.livePhoto && props.onExportLivePhoto && (
          <section className="export-live-photo" aria-label="实况照片兼容包">
            <div className="export-live-photo-head">
              <strong>照片 + 动作兼容包</strong>
              <span className={`live-photo-proof ${props.livePhoto.status}`}>
                {props.livePhoto.status === 'verified' ? 'ID 一致'
                  : props.livePhoto.status === 'mismatch' ? 'ID 不一致'
                    : props.livePhoto.status === 'unverified' ? '未核对'
                      : '核对中'}
              </span>
            </div>
            <p>{props.livePhoto.detail}</p>
            <div className="export-live-actions">
              <button
                type="button"
                className="crop-chip"
                disabled={props.livePhoto.status !== 'verified' || exportingLive}
                onClick={() => void exportLive('download')}
              >{exportingLive ? '正在打包…' : '导出照片 + 动作 ZIP'}</button>
              {props.canShareArchive && (
                <button
                  type="button"
                  className="crop-chip"
                  disabled={props.livePhoto.status !== 'verified' || exportingLive}
                  onClick={() => void exportLive('share')}
                >分享兼容包</button>
              )}
            </div>
            <p className="export-note">
              当前成片强制使用 JPG 并保留拍摄信息，原 MOV 不转码。
              这是同 stem 的两个文件，不冒充 Apple 原生 Live Photo。
            </p>
          </section>
        )}
        {supportsEmbeddedColorProfile(options.format) && (
          <>
            <div className="export-row" role="group" aria-label="导出色彩空间">
              <span className="export-label">色彩</span>
              {([
                ['srgb', 'sRGB'],
                ['display-p3', 'Display P3'],
              ] as const).map(([value, label]) => (
                <label
                  key={value}
                  className={`export-choice${(options.colorSpace ?? 'srgb') === value ? ' on' : ''}`}
                >
                  <input
                    type="radio"
                    name="export-color-space"
                    value={value}
                    checked={(options.colorSpace ?? 'srgb') === value}
                    onChange={() => props.onColorSpace?.(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="export-note color-profile-note">
              {(options.colorSpace ?? 'srgb') === 'display-p3'
                ? '会把 sRGB 像素正确转换并内嵌 Display P3 ICC；当前编辑仍在 sRGB 工作色域，不会恢复超出 sRGB 的颜色。'
                : '会内嵌 sRGB ICC 色彩配置，苹果「预览」、Photoshop 和印刷软件能按同一套颜色解释。'}
            </p>
          </>
        )}

        {props.onFilename && (
          <label className="export-filename">
            <span className="export-label">文件名</span>
            <input
              type="text"
              name="export-filename"
              value={props.filename ?? ''}
              placeholder="留空 = 原文件名_pinkrose"
              spellCheck={false}
              onChange={e => props.onFilename?.(e.target.value)}
            />
          </label>
        )}

        {props.onAspect && (
          <>
            <div className="export-row export-platforms" role="group" aria-label="常用平台">
              <span className="export-label">常用</span>
              {PLATFORM_PRESETS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`crop-chip${options.format === 'image/jpeg'
                    && options.longEdge === p.longEdge
                    && options.aspect === p.aspect ? ' on' : ''}`}
                  title={`${p.aspect} · 长边 ${p.longEdge} · JPG ${p.qualityPct}%`}
                  onClick={() => {
                    props.onFormat('image/jpeg')
                    props.onQuality(p.qualityPct)
                    props.onLongEdge(p.longEdge)
                    props.onAspect?.(p.aspect)
                    props.onFit?.('crop')
                  }}
                >{p.label}</button>
              ))}
              {props.onExportPlatforms && (
                <button
                  type="button"
                  className="crop-chip export-platforms-all"
                  disabled={packingPlatforms}
                  onClick={async () => {
                    setPackingPlatforms(true)
                    try { await props.onExportPlatforms?.() } finally {
                      setPackingPlatforms(false)
                    }
                  }}
                >{packingPlatforms ? '正在打包…' : '全部打包'}</button>
              )}
            </div>
            <p className="export-note">
              平台尺寸会改用 JPG、长边 1080，并按比例居中裁切；之后仍可改格式和方式。
              全部打包会生成一个 ZIP，沿用当前水印和拍摄信息设置。
            </p>
          </>
        )}

        {lossy ? (
          <label className="export-quality">
            <span className="export-label">质量</span>
            <input
              type="range"
              name="export-quality"
              min={60} max={100} step={1}
              value={options.qualityPct}
              onChange={e => props.onQuality(Number(e.target.value))}
            />
            <span className="export-value">{options.qualityPct}%</span>
          </label>
        ) : options.format === 'image/tiff' ? (
          <div className="export-note">TIFF 为无损导出；浏览器支持时用 Deflate 压缩，透明区域会保留。</div>
        ) : (
          <div className="export-note">PNG 无损，不需要质量设置。</div>
        )}

        <div className="export-row" role="group" aria-label="导出尺寸">
          <span className="export-label">尺寸</span>
          {([
            [null, '原图'],
            [2048, '长边 2048'],
            [1080, '长边 1080'],
          ] as const).map(([value, label]) => (
            <label key={String(value)} className={`export-choice${options.longEdge === value ? ' on' : ''}`}>
              <input
                type="radio"
                name="export-size"
                value={value === null ? 'original' : String(value)}
                checked={options.longEdge === value}
                onChange={() => props.onLongEdge(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {props.onAspect && <div className="export-row" role="group" aria-label="导出比例">
          <span className="export-label">比例</span>
          {([
            ['original', '原图'],
            ['1:1', '1:1'],
            ['4:5', '4:5'],
            ['3:4', '3:4'],
            ['4:3', '4:3'],
            ['9:16', '9:16'],
            ['16:9', '16:9'],
          ] as const).map(([value, label]) => (
            <label key={value} className={`export-choice${options.aspect === value ? ' on' : ''}`}>
              <input
                type="radio"
                name="export-aspect"
                value={value}
                checked={options.aspect === value}
                onChange={() => props.onAspect?.(value)}
              />
              {label}
            </label>
          ))}
        </div>}
        {props.onFit && options.aspect && options.aspect !== 'original' && (
          <div className="export-row" role="group" aria-label="扩展方式">
            <span className="export-label">方式</span>
            {([
              ['crop', '裁切'],
              ['blur', '模糊扩展'],
              ['mirror', '镜像扩展'],
            ] as const).map(([value, label]) => (
              <label key={value} className={`export-choice${(options.fit ?? 'crop') === value ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="export-fit"
                  value={value}
                  checked={(options.fit ?? 'crop') === value}
                  onChange={() => props.onFit?.(value)}
                />
                {label}
              </label>
            ))}
          </div>
        )}
        {props.onMetadata && keepsMetadata && (
          <>
            <label className="batch-toggle export-metadata">
              <input
                type="checkbox"
                name="export-metadata"
                checked={options.preserveMetadata !== false}
                onChange={e => props.onMetadata?.(e.target.checked)}
              />
              保留拍摄信息
            </label>
            <p className="export-note">关闭后会移除拍摄时间、相机和 GPS 位置。</p>
            {props.onLocation && options.preserveMetadata !== false && (
              <label className="batch-toggle export-metadata">
                <input
                  type="checkbox"
                  name="export-location"
                  checked={options.preserveLocation !== false}
                  onChange={e => props.onLocation?.(e.target.checked)}
                />
                包含 GPS 位置
              </label>
            )}
          </>
        )}
        {props.onMetadata && !keepsMetadata && (
          <p className="export-note">
            当前格式不写入拍摄信息；需要保留请选 JPG、PNG 或 WebP。
          </p>
        )}
        {props.onCreator && props.onCopyright && keepsMetadata
          && options.preserveMetadata !== false && (
          <>
            <div className="export-rights">
              <label className="export-filename">
                <span className="export-label">作者</span>
                <input
                  type="text"
                  name="export-creator"
                  value={options.creator ?? ''}
                  maxLength={160}
                  placeholder="留空 = 保留原照片作者"
                  spellCheck={false}
                  onChange={e => props.onCreator?.(e.target.value)}
                  onBlur={e => props.onCreator?.(e.target.value)}
                />
              </label>
              <label className="export-filename">
                <span className="export-label">版权</span>
                <input
                  type="text"
                  name="export-copyright"
                  value={options.copyright ?? ''}
                  maxLength={240}
                  placeholder="留空 = 保留原照片版权"
                  spellCheck={false}
                  onChange={e => props.onCopyright?.(e.target.value)}
                  onBlur={e => props.onCopyright?.(e.target.value)}
                />
              </label>
            </div>
            <p className="export-note">
              作者会写入 EXIF Artist，版权会写入 Copyright；TIFF 同样支持。
              标准字段主要面向西文，建议使用英文、数字、拼音和 ©；其他字符会写成 ?。
            </p>
          </>
        )}
        {props.copySupported && props.onCopy && (
          <button
            type="button"
            className="crop-chip export-copy"
            disabled={copying}
            onClick={async () => {
              setCopying(true)
              try { await props.onCopy?.() } finally { setCopying(false) }
            }}
          >{copying ? '复制中…' : '复制图片'}</button>
        )}
        {props.onSaveDefaults && (
          <button
            type="button"
            className="crop-chip export-save-default"
            onClick={props.onSaveDefaults}
          >设为默认</button>
        )}
        {props.watermark && props.onWatermark && (
          <details className="export-watermark">
            <summary>水印</summary>
            <WatermarkControls
              compact
              idPrefix="export"
              options={props.watermark}
              logo={props.watermarkLogo ?? null}
              onChange={props.onWatermark}
              onLogo={props.onWatermarkLogo ?? (() => {})}
            />
          </details>
        )}
      </div>
    </details>
  )
}
