type Props = { onPick: (file: File) => void }

export default function Uploader({ onPick }: Props) {
  return (
    <label className="uploader">
      <input
        type="file"
        accept="image/*"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
        }}
      />
      <span>选一张照片</span>
    </label>
  )
}
