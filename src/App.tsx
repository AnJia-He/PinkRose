import { useCallback, useRef, useState } from 'react'
import Canvas from './ui/Canvas'
import Uploader from './ui/Uploader'
import AdjustmentPanel from './ui/AdjustmentPanel'
import { decodeImageFile, type DecodedImage } from './image/decode'
import { ZERO, type Adjustments } from './core/adjustments'
import { exportImage } from './export/save'

export default function App() {
  const [image, setImage] = useState<DecodedImage | null>(null)
  const [params, setParams] = useState<Adjustments>(ZERO)
  const [showPanel, setShowPanel] = useState(false)
  const [busy, setBusy] = useState(false)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const originalFileRef = useRef<File | null>(null)
  const imageRef = useRef<DecodedImage | null>(null)

  const onPick = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const img = await decodeImageFile(file)
      // 先释放上一张：ImageBitmap 占的是 GPU 内存，不关会一直攒着
      imageRef.current?.bitmap.close()
      imageRef.current = img
      originalFileRef.current = file
      setImage(img)
      setParams(ZERO)
    } catch (e) {
      console.error(e)
      alert('这张图打不开，换一张试试')
    } finally {
      setBusy(false)
    }
  }, [])

  const [saving, setSaving] = useState(false)

  // 导出：画布尺寸就是原图尺寸——调色不缩图（spec §4.4）
  const onSave = useCallback(async () => {
    const canvas = canvasElRef.current
    const file = originalFileRef.current
    if (!canvas || !file) return
    setSaving(true)
    try {
      await exportImage(canvas, file, 'image/jpeg', 0.95)
    } catch (e) {
      console.error(e)
      alert('保存失败，再试一次')
    } finally {
      setSaving(false)
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">RuiXing</span>
        {image && (
          <div className="actions">
            <button onClick={() => setShowPanel(v => !v)}>微调</button>
            <button className="primary" onClick={onSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      </header>

      <main className="stage">
        {!image && !busy && <Uploader onPick={onPick} />}
        {busy && <div className="hint">正在打开照片…</div>}
        {image && (
          <div className="workspace">
            {/* params 直接传下去：[-100,100] → [-1,1] 的换算只发生在
                TonePipeline.render 里（唯一入口） */}
            <Canvas image={image} params={params} canvasRef={canvasElRef} />
          </div>
        )}
      </main>

      {image && showPanel && (
        <AdjustmentPanel
          value={params}
          onChange={setParams}
          onReset={() => setParams(ZERO)}
        />
      )}
    </div>
  )
}
