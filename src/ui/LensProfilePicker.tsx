import { useEffect, useState } from 'react'
import type { Adjustments } from '../../shared/adjustments.ts'
import { readLensInfo, type LensInfo } from '../core/photoInfo.ts'
import {
  LENS_PROFILES, lensProfileAdjustments, matchLensProfile,
} from '../core/lensProfile.ts'
import {
  customLensProfiles, deleteCustomLensProfile, saveCustomLensProfile,
} from '../core/customLensProfiles.ts'

/**
 * 「镜头校正」组里的配置入口（★ 2026-10-20）。
 *
 * 只做三件事：按需读 EXIF → 匹配一条内置配置 → 用户点一下把三条校正值写进
 * 当前参数。**不自动套**：用户可能已经手调过，自动改会在没有提示的情况下
 * 覆盖他的值。认不出镜头时照样能手动选，不把路堵死。
 */
type Props = {
  file: File | null
  value: Adjustments
  onChange: (next: Adjustments) => void
}

export default function LensProfilePicker({ file, value, onChange }: Props) {
  const [info, setInfo] = useState<LensInfo | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [appliedId, setAppliedId] = useState<string | null>(null)
  const [custom, setCustom] = useState(() => customLensProfiles())
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    setInfo(null)
    setSelectedId('')
    setAppliedId(null)
    if (!file) return () => { alive = false }
    void readLensInfo(file).then(next => {
      if (!alive) return
      setInfo(next)
      const match = matchLensProfile(next, customLensProfiles())
      if (match) setSelectedId(match.profile.id)
    })
    return () => { alive = false }
  }, [file])

  const match = info ? matchLensProfile(info, custom) : null
  const allProfiles = [...LENS_PROFILES, ...custom]
  const selected = allProfiles.find(profile => profile.id === selectedId) ?? null
  const focal = info?.focalMm ?? info?.focal35mm ?? null
  const patch = selected ? lensProfileAdjustments(selected, focal) : null
  const badge = selected
    ? (match?.profile.id === selected.id ? '已识别' : '手动选择')
    : match ? '未套用' : info?.lens || info?.model ? '未收录' : '手动选择'
  const focalLabel = selected?.focalRange && focal !== null
    && focal >= selected.focalRange[0] - 0.5 && focal <= selected.focalRange[1] + 0.5
    ? ` · ${Math.round(focal)}mm`
    : ''
  const suggestedName = info?.lens || info?.model || '我的镜头'

  const apply = () => {
    if (!selected || !patch) return
    onChange({ ...value, ...patch })
    setAppliedId(selected.id)
  }

  const save = () => {
    const finalName = name.trim() || suggestedName
    const next = saveCustomLensProfile({
      name: finalName,
      lensText: info?.lens,
      cameraText: [info?.make, info?.model].filter(Boolean).join(' '),
      distortion: value.lensDistortion,
      vignette: value.lensVignette,
      chromatic: value.lensChromatic,
    })
    setCustom(next)
    const created = next.find(profile => profile.custom && profile.label === finalName)
    setSelectedId(created?.id ?? '')
    setAppliedId(null)
    setName('')
    setSaved(true)
  }

  const remove = () => {
    if (!selected?.custom) return
    setCustom(deleteCustomLensProfile(selected.id))
    setSelectedId('')
    setAppliedId(null)
    setSaved(false)
  }

  return (
    <div
      className="lens-profile"
      role="group"
      aria-label="镜头配置文件"
      data-file={file ? file.name : 'none'}
      data-status={info ? (info.hasExif ? 'exif' : 'no-exif') : 'loading'}
    >
      <div className="lens-profile-head">
        <span className="lens-profile-title">镜头配置</span>
        <span className="lens-profile-badge">{badge}</span>
      </div>
      {selected && (
        <p className="lens-profile-name">
          {selected.label}{focalLabel}
        </p>
      )}
      {!selected && info?.lens && (
        <p className="lens-profile-name">EXIF 镜头：{info.lens}</p>
      )}
      <select
        aria-label="选择镜头配置"
        value={selectedId}
        onChange={event => { setSelectedId(event.target.value); setAppliedId(null) }}
      >
        <option value="">不套用</option>
        <optgroup label="内置">
          {LENS_PROFILES.map(profile => (
            <option key={profile.id} value={profile.id}>
              {profile.maker} · {profile.label}
            </option>
          ))}
        </optgroup>
        {custom.length > 0 && (
          <optgroup label="我的配置">
            {custom.map(profile => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </optgroup>
        )}
      </select>
      <div className="lens-profile-save">
        <input
          aria-label="自定义镜头配置名称"
          value={name}
          maxLength={40}
          placeholder={suggestedName}
          onChange={event => { setName(event.target.value); setSaved(false) }}
        />
        <button type="button" className="crop-chip" onClick={save}>存为我的配置</button>
      </div>
      {saved && (
        <p className="lens-profile-hint">已保存在这台设备；下次同一支镜头会按 EXIF 再认出来。</p>
      )}
      <div className="lens-profile-actions">
        <button
          type="button"
          className="crop-chip"
          disabled={!selected}
          onClick={apply}
        >{appliedId === selectedId && selectedId ? '已套用' : '套用配置'}</button>
        {selected?.custom && (
          <button type="button" className="crop-chip" onClick={remove}>删除这条</button>
        )}
        <span className="lens-profile-hint">近似起点，可继续微调</span>
      </div>
      {selected?.note && <p className="lens-profile-hint">{selected.note}</p>}
    </div>
  )
}
