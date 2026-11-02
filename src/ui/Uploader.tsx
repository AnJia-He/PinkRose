import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Camera, FolderOpen, FolderUp, MoreHorizontal, UserRound, Video } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import WelcomeGlobe from './WelcomeGlobe.tsx'
import type { Appearance } from '../app/appearance.ts'
import { PHOTO_FILE_ACCEPT } from '../image/decode'
import {
  inspectLivePhotoPair, isLivePhotoImage, isLivePhotoMovie, pairLivePhotos,
  type LivePhotoEvidence, type LivePhotoPair,
} from '../core/livePhoto'
import { dedupeRawPreviews } from '../core/rawPair'
import logoMark from '../assets/logo/emperor-badge.svg'

const LIVE_PHOTO_ACCEPT = `${PHOTO_FILE_ACCEPT},.mov,video/quicktime`
const SIDECAR_ACCEPT = '.xmp,application/rdf+xml,application/xml,text/xml'
const livePhotoKey = (pair: LivePhotoPair) => `${pair.image.name}:${pair.movie.name}`
const CameraCapture = lazy(() => import('./CameraCapture.tsx'))
const CameraBridge = lazy(() => import('./CameraBridge.tsx'))

function filePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function fileDirectory(file: File): string {
  const path = filePath(file).replace(/\\/g, '/')
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(0, slash + 1) : ''
}

function stem(file: File): string {
  const path = filePath(file).replace(/\\/g, '/')
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase()
}

/** 同目录、同 stem 且只有一份 XMP 时才配对；多个候选不猜。 */
function matchingSidecar(photo: File, files: readonly File[]): File | undefined {
  const matches = files.filter(file =>
    /\.xmp$/i.test(file.name)
    && fileDirectory(file) === fileDirectory(photo)
    && stem(file) === stem(photo))
  return matches.length === 1 ? matches[0] : undefined
}

type Props = {
  /** 选好照片了。`wish` 是用户**在对话区里先打的那句话**（没打就是空串）——
   *  它会被带进对话输入框里，用户按一下发送就行。 */
  onPick: (file: File, wish: string, sidecar?: File) => void
  /** 用户明确选择了“修照片”且该静帧属于一组实况照片时，把 MOV 一并交给上层。 */
  onPickLivePhoto?: (pair: LivePhotoPair, wish: string) => void
  /**
   * Multi-select from the photo library goes to batch processing.
   * A single photo keeps using `onPick`.
   */
  onPickMany?: (files: File[], wish: string, sidecars?: File[]) => void
  /** 相机里录好的短片 → 短片调色。 */
  onRecordVideo?: (file: File) => void
  /** 相机包围曝光整组 → HDR 合成。 */
  onHdrMany?: (files: File[]) => void
  /** 焦点包围整组 → 焦点堆栈。 */
  onFocusMany?: (files: File[]) => void
  appearance?: Appearance
}

/**
 * 上传前那一屏 —— **登录之后看到的第一张脸**。
 *
 * ★ 2026-10-03 重做（用户原话：「这边直接设立对话区，就像主流的 AI 软件对话一样，
 * 显示欢迎使用 PinkRose」）。改的是**形状**，不是内容：
 *   · 原来是一个大虚线框（`<label>` 当按钮）+ 三句提示；
 *   · 现在中间是一条**对话输入框**（`.composer`）：左边是话、右边是「选照片」，
 *     输入框空着时那颗按钮就叫「选照片」，打了字之后叫「发送」——
 *     和 ChatGPT / 豆包那一排长一样。**照片仍然是前提**（产品就是改照片的），
 *     所以按「发送」时如果还没选照片，对话框会弹出来，同时说一句"这句话我先记着"。
 *
 * ★ 2026-10-03 当天又减了一轮：用户看过这一屏之后说「**这些全都不要**」，
 *   **三样一起下线**（别再顺手加回来）——
 *   · 示范句那三个胶囊（连带前面那句"不知道从哪说起？点一个试试"）；
 *   · 「也可以把照片直接拖到这一块上。」；
 *   · 「一天大概能改二十来张照片。」
 *   现在这一屏只剩三样东西：标志、一句话说清这是什么、那条对话输入框。
 *   （额度那句为什么被拿掉，见 docs/文案规范.md「额度怎么说」那一节。）
 *
 * ★ 2026-10-03 同一天第三样：**背景多了一颗图片球**。用户原话「在这个对话框的
 *   背景我想做成一个背景为多个图片朝一个方向转动的图片球体」。它是纯背景 ——
 *   组件 `WelcomeGlobe.tsx`、样式在 styles.css 的 `.globe` 那一段、
 *   那 8 张小图在 `src/assets/welcome/`（一共 31KB，出图脚本写在 `.gitignore`
 *   那条例外旁边的注释里）。
 *   ⚠️ 它挂在 `.welcome` **外面**（这个组件现在返回一个 fragment），
 *   两个理由写在下面那段 JSX 里。
 *
 * 还留着的那两条老规矩（它们是这一屏的价值所在）：
 *   · **一句话说清这是什么** —— 「说句话，照片就修好了」，和落地页 h1 是同一句；
 *   · **一个动作**（选一张照片 / 拖进来）—— 手机上点相册、桌面上拖进来，两条路都要有。
 *     拖进来那句**提示**虽然下线了，**能力还在**（三个拖放事件仍旧挂在整块 `.welcome` 上）：
 *     桌面用户随手拖一张进来，输入框会亮起来接住它。
 *
 * ⚠️ 拖放那三个事件挂在**整块 `.welcome`** 上（不是只挂在输入框那一行）：
 * 一行输入框太窄，而"拖到哪儿算数"要和"看着能不能放"对得上 —— 所以拖进这一块
 * 的任何地方都算，并且此时输入框自己亮起来给反馈（`over`）。
 * ⚠️ `onDragOver` 必须 `preventDefault()`，否则浏览器不认这是一次放置
 * （HTML 规范：默认行为是"不接收"），`onDrop` 根本不会触发。
 * ⚠️ 那个 `input[type=file]` **必须留在 DOM 里**（藏起来、由按钮去点它）：
 * `check:layout` 靠 `waitForSelector('input[type="file"]')` 判断"这一屏到了没有"。
 * ★ 2026-10-18：主按钮旁边补一颗**拍照图标键**（`capture="environment"`）。
 *   它是同一件事的第二条路（相机 vs 相册），不是第二颗主按钮；桌面上浏览器
 *   会自然退化成文件选择。
 */
export default function Uploader({
  onPick, onPickLivePhoto, onPickMany, onRecordVideo, onHdrMany, onFocusMany,
  appearance = 'dark',
}: Props) {
  /** 拖到了这一块里没有。纯视觉 —— 不参与任何判断。 */
  const [over, setOver] = useState(false)
  /** 对话区里先打的那句话。 */
  const [wish, setWish] = useState('')
  /** 打了字、但还没选照片就按了发送 —— 提示一句，别让人以为按钮坏了。 */
  const [nag, setNag] = useState(false)
  const [selectionNote, setSelectionNote] = useState<string | null>(null)
  /** 实时相机取景开着没有。 */
  const [cameraOpen, setCameraOpen] = useState(false)
  /** 相机文件夹桥开着没有。 */
  const [bridgeOpen, setBridgeOpen] = useState(false)
  /** 桌面端把低频导入方式收进一个有文字说明的菜单。 */
  const [moreOpen, setMoreOpen] = useState(false)
  /** 用户同时选到一组或多组同名照片 + MOV 时，先让他决定打开哪一部分。 */
  const [livePhotos, setLivePhotos] = useState<LivePhotoPair[]>([])
  const [livePhotoEvidence, setLivePhotoEvidence] = useState<Record<string, LivePhotoEvidence>>({})
  const livePhotoCheckRef = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const selfieRef = useRef<HTMLInputElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const onPickRef = useRef(onPick)
  const wishRef = useRef(wish)
  useEffect(() => {
    onPickRef.current = onPick
    wishRef.current = wish
  })

  useEffect(() => {
    if (!moreOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && moreRef.current?.contains(event.target)) return
      setMoreOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMoreOpen(false)
      moreRef.current?.querySelector<HTMLButtonElement>('.composer-more-trigger')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [moreOpen])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('input, textarea, [contenteditable="true"]')) return
      const item = Array.from(e.clipboardData?.items ?? [])
        .find(x => x.kind === 'file' && x.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      onPickRef.current(file, wishRef.current.trim())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const clearLivePhotos = () => {
    livePhotoCheckRef.current++
    setLivePhotos([])
    setLivePhotoEvidence({})
  }

  const checkLivePhotos = (pairs: LivePhotoPair[]) => {
    const seq = ++livePhotoCheckRef.current
    setLivePhotoEvidence({})
    void Promise.all(pairs.map(async pair => {
      const key = livePhotoKey(pair)
      try {
        return [key, await inspectLivePhotoPair(pair)] as const
      } catch {
        return [key, {
          status: 'unverified',
          detail: '文件里的实况标识读不出来；当前仅按同名配对。',
          movieId: null,
          imageId: null,
        } satisfies LivePhotoEvidence] as const
      }
    })).then(entries => {
      if (seq !== livePhotoCheckRef.current) return
      setLivePhotoEvidence(Object.fromEntries(entries))
    })
  }

  const take = (files: FileList | null | undefined) => {
    const all = Array.from(files ?? [])
    setSelectionNote(null)
    clearLivePhotos()
    const liveMedia = all.filter(file => isLivePhotoImage(file) || isLivePhotoMovie(file))
    const pairs = pairLivePhotos(liveMedia)
    // 只有这批媒体文件全部都能组成一对一时才进入实况照片选择；混入普通照片
    // 或残缺 MOV 时继续走现有的批量 / 单张流程，不偷偷吞掉别的文件。
    if (pairs.length > 0 && pairs.length * 2 === liveMedia.length) {
      setNag(false)
      setLivePhotos(pairs)
      checkLivePhotos(pairs)
      return
    }
    // 文件夹里可能夹着 .xmp / .txt / 缩略图缓存；只把照片交给上层。
    const picked = all.filter(file =>
      file.type.startsWith('image/')
      || /\.(?:jpe?g|png|webp|avif|heic|heif|tiff?|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i.test(file.name))
    if (picked.length === 0) return
    const paired = dedupeRawPreviews(picked)
    if (paired.skippedPreviews.length > 0) {
      setSelectionNote(
        `已合并 ${paired.skippedPreviews.length} 组同目录 RAW + 预览，保留 RAW 原始数据。`,
      )
    }
    if (paired.files.length > 1 && onPickMany) {
      const sidecars = all.filter(file => /\.xmp$/i.test(file.name))
      if (sidecars.length > 0) onPickMany(paired.files, wish.trim(), sidecars)
      else onPickMany(paired.files, wish.trim())
      return
    }
    const photo = paired.files[0]!
    const sidecar = matchingSidecar(photo, all)
    if (sidecar) onPick(photo, wish.trim(), sidecar)
    else onPick(photo, wish.trim())
  }

  const pickLiveImage = (pair: LivePhotoPair) => {
    clearLivePhotos()
    if (onPickLivePhoto) onPickLivePhoto(pair, wishRef.current.trim())
    else onPickRef.current(pair.image, wishRef.current.trim())
  }

  const playLiveMovie = (pair: LivePhotoPair) => {
    clearLivePhotos()
    onRecordVideo?.(pair.movie)
  }

  /** 「发送」和「选照片」是**同一颗按钮**，只是输入框里有没有话决定了它叫什么。
   *  两条路都要开文件框 —— 照片是前提，话可以先说。 */
  const start = () => {
    setNag(wish.trim().length > 0)
    fileRef.current?.click()
  }

  return (
    <>
      {/* 背景那颗**图片球**（★ 2026-10-03 用户要的，见 WelcomeGlobe.tsx）。
          ⚠️ 它挂在 `.welcome` **外面**、`.stage` 里面，两个原因：
          ① 球要铺满**整块舞台**，而 `.welcome` 是一条 560px 的窄列；
          ② `.welcome` 挂着进场动画（带 transform），而**带 transform 的元素会被
             绝对定位的孩子当成包含块** —— 挂在里面的话，球就只铺满那 560px，
             而且动画那 0.5 秒里还会跟着一起位移。 */}
      <WelcomeGlobe />
      <div
        className="welcome"
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files) }}
      >
        {/* 56px（★ 2026-10-09 换成小皇帝标志后沿用这个数）：44 的时候冕冠那排珠子
            会糊成一片，而它下面是这屏最大的一行字 —— 标志比标题还小会显得没底气。 */}
        <img className="welcome-mark" src={logoMark} alt="" width={56} height={56} />
        <h1 className="welcome-title">欢迎使用 PinkRose</h1>
        <p className="welcome-lede">
          说句话，照片就修好了。旅游拍的、路上随手拍的都行。
        </p>

        {/* ── 对话区 ─────────────────────────────────────────────────────
            它长成对话输入框的样子，但**不是**聊天入口：这一屏还没有照片，
            能做的第一步永远是"选一张"。所以它是一颗**会改名的按钮** ——
            空着叫「选照片」，打了字叫「发送」，按下去都是开文件框。 */}
        <form
          className={`composer${over ? ' over' : ''}`}
          onSubmit={e => { e.preventDefault(); start() }}
        >
          <input
            ref={fileRef}
            className="composer-file"
            type="file"
            data-photo-picker
            accept={`${LIVE_PHOTO_ACCEPT},${SIDECAR_ACCEPT}`}
            multiple
            onChange={e => {
              take(e.target.files)
              e.currentTarget.value = ''
            }}
          />
          <input
            ref={cameraRef}
            className="composer-file"
            type="file"
            accept={PHOTO_FILE_ACCEPT}
            capture="environment"
            onChange={e => take(e.target.files)}
          />
          <input
            ref={selfieRef}
            className="composer-file"
            type="file"
            accept={`${PHOTO_FILE_ACCEPT},${SIDECAR_ACCEPT}`}
            capture="user"
            onChange={e => take(e.target.files)}
          />
          <input
            ref={folderRef}
            className="composer-file"
            type="file"
            data-folder-picker
            accept={PHOTO_FILE_ACCEPT}
            multiple
            {...{ webkitdirectory: '', directory: '' }}
            onChange={e => take(e.target.files)}
          />
          <input
            className="composer-text"
            value={wish}
            onChange={e => { setWish(e.target.value); setNag(false) }}
            placeholder="想怎么改，说一句…"
            aria-label="想怎么改"
            autoComplete="off"
          />
          <div className="composer-import-direct">
            <button
              type="button"
              className="composer-camera"
              aria-label="实时相机"
              title="打开实时相机取景"
              onClick={() => setCameraOpen(true)}
            >
              <Video size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-camera composer-bridge"
              aria-label="相机桥"
              title="从相机 tether 文件夹导入"
              onClick={() => setBridgeOpen(true)}
            >
              <FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-camera"
              aria-label="导入文件夹"
              title="把整个文件夹的照片送进批量处理"
              onClick={() => folderRef.current?.click()}
            >
              <FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-camera"
              aria-label="拍照"
              title="用相机拍一张"
              onClick={() => cameraRef.current?.click()}
            >
              <Camera size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-camera composer-selfie"
              aria-label="自拍"
              title="用前置摄像头自拍一张"
              onClick={() => selfieRef.current?.click()}
            >
              <UserRound size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          <div className="composer-more" ref={moreRef}>
            <button
              type="button"
              className="composer-more-trigger"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls="composer-import-menu"
              onClick={() => setMoreOpen(open => !open)}
            >
              <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
              更多导入
            </button>
            {moreOpen && (
              <div className="composer-import-menu" id="composer-import-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  setMoreOpen(false)
                  setCameraOpen(true)
                }}>
                  <Video size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>用实时相机取景</span>
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMoreOpen(false)
                  setBridgeOpen(true)
                }}>
                  <FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>从相机导入</span>
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMoreOpen(false)
                  folderRef.current?.click()
                }}>
                  <FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>导入整个文件夹</span>
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMoreOpen(false)
                  cameraRef.current?.click()
                }}>
                  <Camera size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>用相机拍一张</span>
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMoreOpen(false)
                  selfieRef.current?.click()
                }}>
                  <UserRound size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>用前置摄像头自拍</span>
                </button>
              </div>
            )}
          </div>
          {/* ⚠️ 主按钮**走 `<Btn>`**（全站只有一份长相那条规矩），
              这里只给它尺寸/圆角（`.composer-go` 在 styles.css 里）。 */}
          <Btn type="submit" className="composer-go">
            {wish.trim() ? '发送' : '选照片'}
          </Btn>
        </form>

        {livePhotos.length > 0 && (
          <section
            className={`live-photo-offer${livePhotos.length > 1 ? ' multiple' : ''}`}
            aria-label="实况照片选择"
            aria-live="polite"
          >
            <div className="live-photo-offer-copy">
              <strong>{livePhotos.length === 1
                ? '找到实况照片'
                : `找到 ${livePhotos.length} 组实况照片`}</strong>
              {livePhotos.length === 1 ? (
                <>
                  <span>{livePhotos[0]!.image.name} + {livePhotos[0]!.movie.name}</span>
                  <p className={`live-photo-proof ${livePhotoEvidence[livePhotoKey(livePhotos[0]!)]?.status ?? 'checking'}`}>
                    {livePhotoEvidence[livePhotoKey(livePhotos[0]!)]?.detail ?? '正在核对 Apple 实况标识…'}
                  </p>
                </>
              ) : (
                <p>逐组选修照片还是动作短片，或者把全部静帧送进批量处理。</p>
              )}
              <p>网页不能直接导出 Apple 原生实况格式；照片和动作仍分开处理。</p>
            </div>
            {livePhotos.length > 1 && (
              <div className="live-photo-list">
                {livePhotos.map(pair => (
                  <div className="live-photo-row" key={`${pair.image.name}:${pair.movie.name}`}>
                    <div className="live-photo-row-main">
                      <span className="live-photo-row-name" title={`${pair.image.name} + ${pair.movie.name}`}>
                        {pair.image.name.replace(/\.[^.]+$/, '')}
                      </span>
                      <span
                        className={`live-photo-proof ${livePhotoEvidence[livePhotoKey(pair)]?.status ?? 'checking'}`}
                        title={livePhotoEvidence[livePhotoKey(pair)]?.detail}
                      >
                        {livePhotoEvidence[livePhotoKey(pair)]?.status === 'verified'
                          ? 'ID 一致'
                          : livePhotoEvidence[livePhotoKey(pair)]?.status === 'mismatch'
                            ? 'ID 不一致'
                            : livePhotoEvidence[livePhotoKey(pair)]?.status === 'unverified'
                              ? '仅同名'
                              : '核对中'}
                      </span>
                    </div>
                    <div className="live-photo-row-actions">
                      <button
                        type="button"
                        className="crop-btn"
                        aria-label={`修照片 ${pair.image.name}`}
                        onClick={() => pickLiveImage(pair)}
                      >修照片</button>
                      {onRecordVideo && (
                        <button
                          type="button"
                          className="crop-btn"
                          aria-label={`调动作 ${pair.movie.name}`}
                          onClick={() => playLiveMovie(pair)}
                        >调动作</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="live-photo-offer-actions">
              {livePhotos.length === 1 ? (
                <Btn
                  type="button"
                  className="live-photo-primary"
                  onClick={() => pickLiveImage(livePhotos[0]!)}
                >修照片</Btn>
              ) : onPickMany && (
                <Btn
                  type="button"
                  className="live-photo-primary"
                  onClick={() => {
                    const images = livePhotos.map(pair => pair.image)
                    clearLivePhotos()
                    onPickMany(images, wishRef.current.trim())
                  }}
                >全部修照片</Btn>
              )}
              {livePhotos.length === 1 && onRecordVideo && (
                <button
                  type="button"
                  className="crop-btn"
                  onClick={() => playLiveMovie(livePhotos[0]!)}
                >调动作</button>
              )}
              <button
                type="button"
                className="crop-btn"
                onClick={clearLivePhotos}
              >不用了</button>
            </div>
          </section>
        )}

        {/* 打了字却没选照片 → 说一句。**不是报错**，是告诉他这句话不会白打。 */}
        {nag && (
          <p className="composer-nag">选一张照片，这句话会一起带过去。</p>
        )}
        {selectionNote && (
          <p className="composer-nag" role="status">{selectionNote}</p>
        )}
      </div>
      {cameraOpen && (
        <Suspense fallback={(
          <div className="camera-dialog" data-theme={appearance} role="status">
            <div className="camera-panel camera-loading">正在打开相机…</div>
          </div>
        )}>
          <CameraCapture
            open
            appearance={appearance}
            onClose={() => setCameraOpen(false)}
            onCapture={file => {
              setCameraOpen(false)
              onPick(file, wish.trim())
            }}
            onCaptureMany={files => {
              setCameraOpen(false)
              onPickMany?.(files, wish.trim())
            }}
            onRecorded={file => {
              setCameraOpen(false)
              onRecordVideo?.(file)
            }}
          />
        </Suspense>
      )}
      {bridgeOpen && (
        <Suspense fallback={(
          <div className="camera-dialog" data-theme={appearance} role="status">
            <div className="camera-panel camera-loading">正在打开相机桥…</div>
          </div>
        )}>
          <CameraBridge
            open
            appearance={appearance}
            onClose={() => setBridgeOpen(false)}
            onImport={(file, sidecar) => {
              setBridgeOpen(false)
              if (sidecar) onPick(file, wish.trim(), sidecar)
              else onPick(file, wish.trim())
            }}
            onImportMany={(files, sidecars) => {
              setBridgeOpen(false)
              if (sidecars?.length) onPickMany?.(files, wish.trim(), sidecars)
              else onPickMany?.(files, wish.trim())
            }}
            onHdrMany={files => {
              setBridgeOpen(false)
              onHdrMany?.(files)
            }}
            onFocusMany={files => {
              setBridgeOpen(false)
              onFocusMany?.(files)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
