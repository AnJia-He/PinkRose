import {
  lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { ChevronDown, Clock3, Layers3, Maximize2 } from 'lucide-react'
import {
  listWorks, fileUrl, deleteWorks, rateWork, rateWorks, flagWork, flagWorks,
  colorWork, colorWorks,
  fetchWorkFullImage, fetchWorkThumb,
} from '../api/works'
import {
  addWorksToAlbum, createAlbum, deleteAlbum, listAlbums,
  removeWorksFromAlbum, renameAlbum,
} from '../api/albums'
import { errorText } from '../api/client'
import {
  cameraName, workName, workNameAt, matchesQuery, matchesQueryAt,
  WORK_COLORS, WORK_COLOR_LABELS,
  type AlbumMeta, type WorkColor, type WorkMeta,
} from '../../shared/works.ts'
import { usePagedDays } from './kit/pagedDays.ts'
import { stackBursts, type GalleryEntry } from '../core/gallery.ts'
import { SelectBar } from './kit/SelectBar.tsx'
import { Btn } from './kit/Btn.tsx'
import RatingStars from './RatingStars.tsx'
import CullingLightbox from './CullingLightbox'
// ★ 2026-10-11（设计跟进 Task 2）：打不开时的标准件（居中一句 + 「再试一次」）。
import { ErrorState } from './kit/ErrorState.tsx'
// ★ 2026-10-10：按大小排那档里每格要写大小 —— 口径和用户管理页那个用量图
//   **同一份**（'342 MB' / '1.5 GB'），别在这儿再写一个格式化。
import { formatSize } from './AccountPage'
// 作品页里的重工作流按需加载：打开修图页时不需要下载批量、视频、拼图等整套代码。
const BatchPanel = lazy(() => import('./BatchPanel'))
const CollagePanel = lazy(() => import('./CollagePanel'))
const IdPhotoPanel = lazy(() => import('./IdPhotoPanel'))
const PrintPanel = lazy(() => import('./PrintPanel'))
const PanoramaPanel = lazy(() => import('./PanoramaPanel'))
const HdrPanel = lazy(() => import('./HdrPanel'))
const LongExposurePanel = lazy(() => import('./LongExposurePanel'))
const FocusStackPanel = lazy(() => import('./FocusStackPanel'))
const GridSplitPanel = lazy(() => import('./GridSplitPanel'))
const LongImagePanel = lazy(() => import('./LongImagePanel'))
const GifPanel = lazy(() => import('./GifPanel'))
const VideoPanel = lazy(() => import('./VideoPanel'))
const PhotoMoviePanel = lazy(() => import('./PhotoMoviePanel'))
const PosterPanel = lazy(() => import('./PosterPanel'))
import { downloadWorksZip } from '../batch/works'
import { MAX_BATCH_FILES } from '../batch/process'
import { downloadImage } from '../export/save'
import type { Adjustments } from '../../shared/adjustments.ts'
import { perceptualHashFromBlob } from '../image/perceptualHash'
import { isSimilarHash } from '../core/perceptualHash'
import { analyzePhotoBlob } from '../image/cull'
import { assessCull, type CullMetrics } from '../core/cull'

const similarHashCache = new Map<string, Promise<string>>()

function LazyWorkflow({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="app-loading">正在打开工具…</div>}>
      {children}
    </Suspense>
  )
}

function burstClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const editedTime = (work: WorkMeta): number => work.updatedAt
const shotTime = (work: WorkMeta): number => (
  typeof work.capturedAt === 'number' && work.capturedAt > 0
    ? work.capturedAt
    : work.updatedAt
)
const matchesEditedQuery = (work: WorkMeta, query: string, now: number): boolean =>
  matchesQuery(work, query, now)
const matchesShotQuery = (work: WorkMeta, query: string, now: number): boolean =>
  matchesQueryAt(work, query, now, shotTime(work))

function workHashKey(work: WorkMeta): string {
  return `${work.id}:${work.updatedAt}:${work.hasThumb ? 'thumb' : 'file'}`
}

function workHash(work: WorkMeta): Promise<string> {
  const key = workHashKey(work)
  const old = similarHashCache.get(key)
  if (old) return old
  const pending = fetchWorkThumb(work).then(perceptualHashFromBlob)
  similarHashCache.set(key, pending)
  pending.catch(() => similarHashCache.delete(key))
  return pending
}

async function eachLimited<T>(
  items: readonly T[], limit: number, run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!
      await run(item)
    }
  })
  await Promise.all(workers)
}

export function GalleryPage({
  onOpen, onNew, currentParams, batchSeed, onBatchSeedUsed, defaultStyleId,
  videoSeed, onVideoSeedUsed, hdrSeed, onHdrSeedUsed,
  focusSeed, onFocusSeedUsed,
}: {
  onOpen: (id: number) => void
  /** ★ 2026-10-11（设计跟进 T5）：空态那颗「去改一张」的去处 —— App 传的
   *  和对话列表空态**同一条路**（回修图页的上传前那一屏）。 */
  onNew: () => void
  /** 编辑器里正在用的调色参数；批量处理可以选「当前调色」。 */
  currentParams?: Adjustments | null
  /** Multi-selected files from the photo library. */
  batchSeed?: File[] | null
  /** Clear the seed once the batch workspace has consumed it. */
  onBatchSeedUsed?: () => void
  /** 相机录好的短片 → 直接打开短片调色。 */
  videoSeed?: File[] | null
  onVideoSeedUsed?: () => void
  /** 包围曝光整组 → 直接打开 HDR 合成。 */
  hdrSeed?: File[] | null
  onHdrSeedUsed?: () => void
  /** 焦点包围整组 → 直接打开焦点堆栈。 */
  focusSeed?: File[] | null
  onFocusSeedUsed?: () => void
  /** 设置页默认风格：批量入口也按它起手。 */
  defaultStyleId?: string | null
}) {
  /** null = 还没拿到。**它和"没有作品"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没有作品"，用户会以为东西没了。 */
  const [works, setWorks] = useState<WorkMeta[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [q, setQ] = useState('')
  /** 零作品时先收住高级创作入口；手机上仍由 CSS 保持原样。 */
  const [emptyToolsOpen, setEmptyToolsOpen] = useState(false)
  /**
   * ★ 2026-10-10：**排序**。加它的来路：空间要满的时候（5 GB 配额，用户管理页
   * 会提醒），用户要来这儿找"谁最占地方" —— 按大小降序、每格把大小写出来。
   * ⚠️ 按大小**不分天**：分组的前提是时间序（同一天的聚在一起）；按大小还分天
   *   的话，"最大的那几张"会散在几十个组里，一眼扫不出来。
   */
  const [sort, setSort] = useState<'time' | 'size'>('time')
  /** 时间视图按最近编辑还是 EXIF 拍摄时间分组；没有 EXIF 的作品自动回退。 */
  const [timeBasis, setTimeBasis] = useState<'edited' | 'shot'>('edited')
  /** 连拍堆栈是浏览层；关掉后仍回到一张一格的原始列表。 */
  const [burstStacking, setBurstStacking] = useState(true)
  const [expandedStacks, setExpandedStacks] = useState<string[]>([])
  const [minRating, setMinRating] = useState(0)
  const [flagFilter, setFlagFilter] = useState<'all' | 'pick' | 'reject'>('all')
  const [colorFilter, setColorFilter] = useState<WorkColor | 'all'>('all')
  const [gearFilter, setGearFilter] = useState('all')
  const [albums, setAlbums] = useState<AlbumMeta[] | null>(null)
  const [albumId, setAlbumId] = useState<number | null>(null)
  const [albumReload, setAlbumReload] = useState(0)
  const [albumBusy, setAlbumBusy] = useState(false)
  /** 相册整组进批量处理：取原图的忙碌态 / 取好的文件。 */
  const [albumBatchBusy, setAlbumBatchBusy] = useState(false)
  const [albumBatchFiles, setAlbumBatchFiles] = useState<File[] | null>(null)
  /** 整组进批量页后仍要看见的来源说明（取到几张 / 有没有跳过的张数）。 */
  const [albumBatchNote, setAlbumBatchNote] = useState<string | null>(null)
  /** 相册整组下载 ZIP 的忙碌态（和选择条那个下载分开）。 */
  const [albumDownloading, setAlbumDownloading] = useState(false)
  const [albumStatus, setAlbumStatus] = useState<string | null>(null)
  const [albumEditor, setAlbumEditor] = useState<
    { mode: 'create' | 'rename'; value: string } | null
  >(null)
  const [confirmAlbumDelete, setConfirmAlbumDelete] = useState(false)
  /**
   * ★ 2026-10-10：**选择模式**（多选批删）。形状照对话列表（`SessionsPage`）：
   * 开着的这一档里每格左上角一颗勾选框、点格子 = 勾选（**不打开**详情）、
   * 底下吸一条操作条（`kit/SelectBar`，同一个组件）。
   * 删除走**批量接口** `deleteWorks`（一次往返；它自己在服务端逐条删、如实回报）。
   */
  const [selecting, setSelecting] = useState(false)
  /** 勾了哪几张。**出去就清空**；删失败时保留 —— 直接再点一次【删除】就是重试。 */
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  /** 批删的就地确认开着没有（删前一律先问 —— 一张作品也是花过钱的图）。 */
  const [confirmAsk, setConfirmAsk] = useState(false)
  /** 删这一趟在飞。两颗按钮全禁用，防连点。 */
  const [deleting, setDeleting] = useState(false)
  /** 选中作品正在打包下载。 */
  const [downloading, setDownloading] = useState(false)
  /** 选择条上的下载状态；换勾选时清掉，避免旧结果挂在新的选择上。 */
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null)
  /** 批量评分正在提交；和下载一样锁住选择条里的其它动作。 */
  const [ratingBusy, setRatingBusy] = useState(false)
  /** 评分结果句；换勾选时清掉，避免旧结果挂在新的选择上。 */
  const [ratingStatus, setRatingStatus] = useState<string | null>(null)
  /** 批量颜色标签正在提交；和评分一样锁住选择条里的其它动作。 */
  const [colorBusy, setColorBusy] = useState(false)
  const [colorStatus, setColorStatus] = useState<string | null>(null)
  const [similarBusy, setSimilarBusy] = useState(false)
  const [similarStatus, setSimilarStatus] = useState<string | null>(null)
  const [bestBusy, setBestBusy] = useState(false)
  const [bestStatus, setBestStatus] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<string | null>(null)
  /** 删失败。⚠️ 和 `failed` 分开：那句是"整页读不出来"（整页就是它），
   *  这一句只加在列表**上面**，名单原样不动（照 SessionsPage 的 `delFailed`）。 */
  const [delFailed, setDelFailed] = useState<string | null>(null)

  /**
   * 「再试一次」的扳机（★ 2026-10-11）：把它加一，下面那个 effect 就重跑一趟。
   *
   * ⚠️ 为什么是"重跑 effect"而不是把加载那段提成一个函数：那份 `alive` 闸
   *   （卸载后不许 setState）**只对着它自己那次 effect 的清理时机**才对得上 ——
   *   提出来之后"什么时候算过期"就得在函数里另写一套判断，两套迟早对不上。
   */
  const [reload, setReload] = useState(0)
  /** 批量处理工作区开着没有。它是本页的一个模式；返回时名单和搜索词都还在。 */
  const [batchOpen, setBatchOpen] = useState(false)
  /** 拼图工作区。和批量处理互斥，返回时作品名单原样留着。 */
  const [collageOpen, setCollageOpen] = useState(false)
  /** 证件照工作区。单张照片的本地工作流。 */
  const [idPhotoOpen, setIdPhotoOpen] = useState(false)
  /** 打印排版工作区。和证件照 / 拼图 / 批量处理互斥。 */
  const [printOpen, setPrintOpen] = useState(false)
  /** 全景拼接工作区。和上面几个本地工作模式互斥。 */
  const [panoramaOpen, setPanoramaOpen] = useState(false)
  /** HDR 合成工作区。和上面几个本地工作模式互斥。 */
  const [hdrOpen, setHdrOpen] = useState(false)
  const [hdrInitial, setHdrInitial] = useState<File[] | null>(null)
  /** 长曝光工作区。和上面几个本地工作模式互斥。 */
  const [longExposureOpen, setLongExposureOpen] = useState(false)
  /** 焦点堆栈工作区。和上面几个本地工作模式互斥。 */
  const [focusOpen, setFocusOpen] = useState(false)
  const [focusInitial, setFocusInitial] = useState<File[] | null>(null)
  /** 九宫格切图工作区。和上面几个本地工作模式互斥。 */
  const [gridOpen, setGridOpen] = useState(false)
  /** 长图拼接工作区。和上面几个本地工作模式互斥。 */
  const [longImageOpen, setLongImageOpen] = useState(false)
  /** 照片动图工作区。和上面几个本地工作模式互斥。 */
  const [gifOpen, setGifOpen] = useState(false)
  /** 短片调色工作区。和照片动图是两件事：一个拼照片，一个修已有视频。 */
  const [videoOpen, setVideoOpen] = useState(false)
  /** 照片电影：几张照片配推拉和音乐。 */
  const [movieOpen, setMovieOpen] = useState(false)
  /** 社交封面工作区。 */
  const [posterOpen, setPosterOpen] = useState(false)
  /** 全屏看片：打开时把过滤后的序列快照下来，评分变化不会把当前张跳走。 */
  const [loupe, setLoupe] = useState<{
    ids: number[]; id: number; compare?: boolean
  } | null>(null)
  const similarSeqRef = useRef(0)
  const bestSeqRef = useRef(0)
  const reviewSeqRef = useRef(0)

  useEffect(() => {
    if (batchSeed?.length) setBatchOpen(true)
  }, [batchSeed])

  useEffect(() => {
    if (videoSeed?.length) setVideoOpen(true)
  }, [videoSeed])

  useEffect(() => {
    if (!hdrSeed?.length) return
    setHdrInitial(hdrSeed)
    setHdrOpen(true)
    onHdrSeedUsed?.()
  }, [hdrSeed, onHdrSeedUsed])

  useEffect(() => {
    if (!focusSeed?.length) return
    setFocusInitial(focusSeed)
    setFocusOpen(true)
    onFocusSeedUsed?.()
  }, [focusSeed, onFocusSeedUsed])

  useEffect(() => {
    let alive = true
    setWorks(null)
    setFailed(null)
    listWorks(albumId ?? undefined).then(
      (ws) => { if (alive) setWorks(ws) },
      (e) => { if (alive) setFailed(errorText(e, '打不开作品集')) },
    )
    return () => { alive = false }
  }, [reload, albumId])

  useEffect(() => {
    let alive = true
    listAlbums().then(
      (list) => { if (alive) setAlbums(list) },
      (e) => { if (alive) setAlbumStatus(errorText(e, '相册清单没取回来')) },
    )
    return () => { alive = false }
  }, [albumReload])

  /** 「再试一次」：清掉那句错误（屏幕当场换回"正在打开…"）、重跑加载。 */
  function retry() {
    setFailed(null)
    setReload(n => n + 1)
  }

  /** 按天分组 + 分页 + 滚到底的哨兵：和对话列表**同一套**（`kit/pagedDays`）。 */
  const filteredWorks = useMemo(
    () => works ? works.filter(w => (
      (minRating === 0 || w.rating >= minRating)
      && (flagFilter === 'all' || (flagFilter === 'pick' ? w.flag === 1 : w.flag === -1))
      && (colorFilter === 'all' || (w.color ?? 'none') === colorFilter)
      && (
        gearFilter === 'all'
        || gearFilter === `camera:${cameraName(w) ?? ''}`
        || gearFilter === `lens:${w.lensModel?.trim() ?? ''}`
      )
    )) : null,
    [works, minRating, flagFilter, colorFilter, gearFilter],
  )
  const gearOptions = useMemo(() => {
    const cameras = new Map<string, number>()
    const lenses = new Map<string, number>()
    for (const work of works ?? []) {
      const camera = cameraName(work)
      const lens = work.lensModel?.trim()
      if (camera) cameras.set(camera, (cameras.get(camera) ?? 0) + 1)
      if (lens) lenses.set(lens, (lenses.get(lens) ?? 0) + 1)
    }
    return {
      cameras: [...cameras.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')),
      lenses: [...lenses.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')),
    }
  }, [works])
  useEffect(() => {
    if (gearFilter === 'all') return
    const exists = gearOptions.cameras.some(([name]) => gearFilter === `camera:${name}`)
      || gearOptions.lenses.some(([name]) => gearFilter === `lens:${name}`)
    if (!exists) setGearFilter('all')
  }, [gearFilter, gearOptions])
  const timeOf = timeBasis === 'shot' ? shotTime : editedTime
  const matchQuery = timeBasis === 'shot' ? matchesShotQuery : matchesEditedQuery
  const hasCapturedTime = works?.some(work => (
    typeof work.capturedAt === 'number' && work.capturedAt > 0
  )) ?? false
  const { now, groups, shown, more, sentinel, resetLimit } =
    usePagedDays(filteredWorks, q, matchQuery, timeOf)
  const burstDays = useMemo(() => {
    const entries = new Map<string, GalleryEntry<WorkMeta>[]>()
    let stackCount = 0
    for (const group of shown) {
      const stacked = stackBursts(group.works)
      entries.set(group.day, stacked)
      stackCount += stacked.filter(entry => entry.kind === 'stack').length
    }
    return { entries, stackCount }
  }, [shown])
  const activeAlbum = albums?.find(album => album.id === albumId) ?? null

  /** 退出选择模式（「取消」和"删完"都走它）：勾清空、确认条收掉。 */
  function exitSelect() {
    setSelecting(false)
    setSelectedIds([])
    setConfirmAsk(false)
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setSimilarStatus(null)
    setBestStatus(null)
    setReviewStatus(null)
    setAlbumStatus(null)
    similarSeqRef.current++
    bestSeqRef.current++
    reviewSeqRef.current++
  }

  /** 所有“进入多选”的入口共用一份复位逻辑；可带上一整组现成的 id。 */
  function beginSelect(ids: number[] = []) {
    setSelectedIds(ids)
    setConfirmAsk(false)
    setDelFailed(null)
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setSimilarStatus(null)
    setBestStatus(null)
    setReviewStatus(null)
    setAlbumStatus(null)
    setAlbumEditor(null)
    setConfirmAlbumDelete(false)
    similarSeqRef.current++
    bestSeqRef.current++
    reviewSeqRef.current++
    setSelecting(true)
  }

  function toggleStack(key: string) {
    setExpandedStacks(keys => (
      keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key]
    ))
  }

  function toggleStackSelection(works: readonly WorkMeta[], key: string) {
    const ids = [...new Set(works.map(work => work.id))]
    const allSelected = selecting && ids.every(id => selectedIds.includes(id))
    if (allSelected) {
      setSelectedIds(current => current.filter(id => !ids.includes(id)))
      return
    }
    beginSelect([...new Set([...selectedIds, ...ids])])
    setExpandedStacks(keys => (keys.includes(key) ? keys : [...keys, key]))
  }

  /** 勾 / 取消勾一张（勾选框、整格两个入口都走它）。 */
  function togglePick(id: number) {
    if (deleting || downloading || ratingBusy || colorBusy || similarBusy
      || bestBusy || reviewBusy) return
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setSimilarStatus(null)
    setBestStatus(null)
    setReviewStatus(null)
    similarSeqRef.current++
    bestSeqRef.current++
    reviewSeqRef.current++
    setAlbumStatus(null)
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  /**
   * 批量删：**一次请求**（`deleteWorks` 就是为它准备的批量接口 —— 它在服务端
   * 逐条删、如实回报 `{ deleted, missing }`，见 `server/works.ts`）。
   *
   * `missing`（服务端说"它本来就不在"）也当场清掉 —— **目标已达成**，
   * 对用户来说结果一样是"它没了"。
   *
   * ⚠️ **失败不清场**：名单原样、勾保留（直接再点一次就是重试）。服务端那边
   *   已经删掉的几张要等下次刷新才消失 —— 这是**有意的**：宁可让用户看到旧
   *   名单再点一次，也不装作"都删干净了"（这个项目最恨的那种失败：错了不报错）。
   */
  async function doBatchDelete() {
    setConfirmAsk(false)
    setDelFailed(null)
    setDeleting(true)
    try {
      const { deleted, missing } = await deleteWorks(selectedIds)
      const gone = new Set([...deleted, ...missing])
      setWorks(ws => ws?.filter(w => !gone.has(w.id)) ?? null)
      exitSelect()
    } catch {
      // ⚠️ 文案**自己造**，不走 `errorText` —— 那个让服务端的 message 优先，
      //   而服务端那句（"服务器开小差了"之类）说不出"再试一次"这条**出路**，
      //   §3.7 要的正是它（照 SessionsPage 批删那条先例）。
      setDelFailed('没删完，再试一次？')
    } finally {
      setDeleting(false)
    }
  }

  /** 选中作品 → 原图逐张取回 → 一个 ZIP 下载。失败项如实留在状态句里。 */
  async function doBatchDownload() {
    if (!works || selectedIds.length === 0) return
    const chosen = works.filter(w => selectedIds.includes(w.id))
    setDownloading(true)
    setDownloadStatus('正在取照片…')
    try {
      const result = await downloadWorksZip(chosen, p => {
        setDownloadStatus(`正在取 ${p.completed} / ${p.total}…`)
      })
      if (result.archive) downloadImage(result.archive, result.archiveName)
      setDownloadStatus(result.failures.length === 0
        ? `已下载 ${result.succeeded} 张。`
        : `下载了 ${result.succeeded} 张，${result.failures.length} 张没取到。`)
    } catch (e) {
      console.error('批量下载没完成', e)
      setDownloadStatus('没下载成，再试一次？')
    } finally {
      setDownloading(false)
    }
  }

  /** 按大小的那份名单（搜索照样管它 —— 名字过滤在哪一档都成立）。
   *  `filter` 先复制，`sort` 动的不是 state 里那一份。 */
  const sizeList = filteredWorks
    ? filteredWorks.filter(w => matchesQuery(w, q, now)).sort((a, b) => b.bytes - a.bytes)
    : []

  const selectedWorks = useMemo(
    () => works?.filter(w => selectedIds.includes(w.id)) ?? [],
    [works, selectedIds],
  )
  const loupeWorks = useMemo(() => {
    if (!loupe || !works) return []
    const byId = new Map(works.map(w => [w.id, w]))
    return loupe.ids.flatMap(id => {
      const work = byId.get(id)
      return work ? [work] : []
    })
  }, [loupe, works])
  const loupeIndex = loupe
    ? Math.max(0, loupeWorks.findIndex(w => w.id === loupe.id))
    : 0

  function openLoupe(work: WorkMeta) {
    const ids = (filteredWorks ?? [])
      .filter(w => matchQuery(w, q, now))
      .sort((a, b) => timeOf(b) - timeOf(a))
      .map(w => w.id)
    setLoupe({ ids, id: work.id, compare: false })
  }

  function compareSelected() {
    if (selectedWorks.length !== 2) return
    setLoupe({
      ids: selectedWorks.map(work => work.id),
      id: selectedWorks[0]!.id,
      compare: true,
    })
  }

  function moveLoupe(next: number) {
    const work = loupeWorks[next]
    if (work) setLoupe(current => (current ? { ...current, id: work.id } : current))
  }

  /** 选中作品星级相同时显示那套星；混合选择显示 0，点任意星统一覆盖。 */
  const selectedRating = selectedWorks.length > 0
    && selectedWorks.every(w => w.rating === selectedWorks[0]!.rating)
    ? selectedWorks[0]!.rating
    : 0
  const selectedColor = selectedWorks.length > 0
    && selectedWorks.every(w => (w.color ?? 'none') === (selectedWorks[0]!.color ?? 'none'))
    ? (selectedWorks[0]!.color ?? 'none')
    : null

  async function rateSelected(rating: number) {
    if (selectedIds.length === 0 || ratingBusy || deleting || downloading) return
    const ids = [...selectedIds]
    const previous = new Map(selectedWorks.map(w => [w.id, w.rating]))
    setRatingBusy(true)
    setRatingStatus(null)
    setReviewStatus(null)
    reviewSeqRef.current++
    setDownloadStatus(null)
    setWorks(list => list?.map(w => (previous.has(w.id) ? { ...w, rating } : w)) ?? null)
    try {
      const result = await rateWorks(ids, rating)
      const missing = new Set(result.missing)
      if (missing.size > 0) {
        setWorks(list => list?.filter(w => !missing.has(w.id)) ?? null)
        setSelectedIds(current => current.filter(id => !missing.has(id)))
      }
      if (result.rated.length === 0) {
        setRatingStatus('这些作品已经不在作品集里了。')
      } else {
        const done = rating === 0
          ? `已清除 ${result.rated.length} 张的评分`
          : `已给 ${result.rated.length} 张打 ${rating} 星`
        setRatingStatus(missing.size > 0 ? `${done}，${missing.size} 张已不在作品集。` : `${done}。`)
      }
    } catch (e) {
      setWorks(list => list?.map(w => (
        previous.has(w.id) ? { ...w, rating: previous.get(w.id)! } : w
      )) ?? null)
      setRatingStatus(errorText(e, '评分没存上，再试一次'))
    } finally {
      setRatingBusy(false)
    }
  }

  async function paintSelected(color: WorkColor) {
    if (selectedIds.length === 0 || colorBusy || deleting || downloading) return
    const ids = [...selectedIds]
    const previous = new Map(selectedWorks.map(w => [w.id, w.color ?? 'none']))
    setColorBusy(true)
    setColorStatus(null)
    setReviewStatus(null)
    reviewSeqRef.current++
    setRatingStatus(null)
    setDownloadStatus(null)
    setWorks(list => list?.map(w => (
      previous.has(w.id) ? { ...w, color } : w
    )) ?? null)
    try {
      const result = await colorWorks(ids, color)
      const missing = new Set(result.missing)
      if (missing.size > 0) {
        setWorks(list => list?.filter(w => !missing.has(w.id)) ?? null)
        setSelectedIds(current => current.filter(id => !missing.has(id)))
      }
      if (result.colored.length === 0) {
        setColorStatus('这些作品已经不在作品集里了。')
      } else {
        const done = color === 'none'
          ? `已清除 ${result.colored.length} 张的颜色标签`
          : `已给 ${result.colored.length} 张标${WORK_COLOR_LABELS[color]}色`
        setColorStatus(missing.size > 0
          ? `${done}，${missing.size} 张已不在作品集。`
          : `${done}。`)
      }
    } catch (e) {
      setWorks(list => list?.map(w => (
        previous.has(w.id) ? { ...w, color: previous.get(w.id) } : w
      )) ?? null)
      setColorStatus(errorText(e, '颜色标签没存上，再试一次'))
    } finally {
      setColorBusy(false)
    }
  }

  async function selectSimilar() {
    const seed = selectedWorks.length === 1 ? selectedWorks[0]! : null
    const pool = (filteredWorks ?? []).filter(work => matchesQuery(work, q, now))
    if (!seed || similarBusy || bestBusy || deleting || downloading
      || ratingBusy || colorBusy || albumBusy) return
    const seq = ++similarSeqRef.current
    setSimilarBusy(true)
    setSimilarStatus('正在比较缩略图…')
    setReviewStatus(null)
    reviewSeqRef.current++
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setBestStatus(null)
    setAlbumStatus(null)
    try {
      const seedHash = await workHash(seed)
      const matches: number[] = []
      let failed = 0
      await eachLimited(
        pool.filter(work => work.id !== seed.id),
        6,
        async work => {
          try {
            if (isSimilarHash(seedHash, await workHash(work))) matches.push(work.id)
          } catch {
            failed++
          }
        },
      )
      if (seq !== similarSeqRef.current) return
      matches.sort((a, b) => a - b)
      setSelectedIds([seed.id, ...matches])
      setSimilarStatus(matches.length
        ? `找到 ${matches.length} 张相近照片，已一起选中。`
          + (failed ? `${failed} 张缩略图没读到，已跳过。` : '')
        : `没找到相近照片。${failed ? `${failed} 张缩略图没读到。` : '换一张起点试试。'}`)
    } catch (e) {
      if (seq !== similarSeqRef.current) return
      console.error('相似照片分析失败', e)
      setSimilarStatus('这张的缩略图没读到，换一张试试。')
    } finally {
      if (seq === similarSeqRef.current) setSimilarBusy(false)
    }
  }

  async function chooseBestFrom(candidates: readonly WorkMeta[]) {
    if (candidates.length < 2 || bestBusy || deleting || downloading
      || ratingBusy || colorBusy || similarBusy || albumBusy) return
    const seq = ++bestSeqRef.current
    const selected = [...candidates]
    setBestBusy(true)
    setBestStatus('正在比较清晰度和曝光…')
    setReviewStatus(null)
    reviewSeqRef.current++
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setSimilarStatus(null)
    setAlbumStatus(null)
    try {
      const rows: { work: WorkMeta; metrics: CullMetrics }[] = []
      let failed = 0
      await eachLimited(selected, 4, async work => {
        try {
          rows.push({ work, metrics: await analyzePhotoBlob(await fetchWorkThumb(work)) })
        } catch {
          failed++
        }
      })
      if (seq !== bestSeqRef.current) return
      if (rows.length === 0) {
        setBestStatus('这组缩略图都没读到，换几张再试。')
        return
      }
      rows.sort((a, b) => selected.findIndex(w => w.id === a.work.id)
        - selected.findIndex(w => w.id === b.work.id))
      const verdicts = assessCull(rows.map(row => row.metrics))
      let bestIndex = 0
      for (let i = 1; i < verdicts.length; i++) {
        if (verdicts[i]!.score > verdicts[bestIndex]!.score) bestIndex = i
      }
      const best = rows[bestIndex]!
      const verdict = verdicts[bestIndex]!
      setSelectedIds([best.work.id])
      setBestStatus(
        `这一组推荐「${workName(best.work, now)}」：${verdict.reason}，`
        + `本机评分 ${Math.round(verdict.score * 100)}。`
        + (failed ? `${failed} 张没分析成。` : ''),
      )
    } catch (e) {
      if (seq !== bestSeqRef.current) return
      console.error('最佳照片分析失败', e)
      setBestStatus('没能比较这组照片，再试一次。')
    } finally {
      if (seq === bestSeqRef.current) setBestBusy(false)
    }
  }

  async function chooseBest() {
    await chooseBestFrom(selectedWorks)
  }

  function chooseBestInStack(works: readonly WorkMeta[], key: string) {
    beginSelect(works.map(work => work.id))
    setExpandedStacks(keys => (keys.includes(key) ? keys : [...keys, key]))
    void chooseBestFrom(works)
  }

  async function reviewSelected() {
    if (selectedWorks.length < 2 || reviewBusy || deleting || downloading
      || ratingBusy || colorBusy || similarBusy || bestBusy || albumBusy) return
    const seq = ++reviewSeqRef.current
    const selected = [...selectedWorks]
    setReviewBusy(true)
    setReviewStatus('正在检查清晰度和曝光…')
    setDownloadStatus(null)
    setRatingStatus(null)
    setColorStatus(null)
    setSimilarStatus(null)
    setBestStatus(null)
    setAlbumStatus(null)
    try {
      const rows: { work: WorkMeta; metrics: CullMetrics }[] = []
      await eachLimited(selected, 4, async work => {
        try {
          rows.push({ work, metrics: await analyzePhotoBlob(await fetchWorkThumb(work)) })
        } catch {
          // 单张缩略图读不出来时继续分析其它张，结果句会如实统计。
        }
      })
      if (seq !== reviewSeqRef.current) return
      if (rows.length === 0) {
        setReviewStatus('这组缩略图都没读到，换几张再试。')
        return
      }

      rows.sort((a, b) => selected.findIndex(w => w.id === a.work.id)
        - selected.findIndex(w => w.id === b.work.id))
      const verdicts = assessCull(rows.map(row => row.metrics))
      const updates = rows.map((row, i) => ({
        work: row.work,
        previous: row.work.flag,
        flag: (verdicts[i]!.keep ? 1 : -1) as -1 | 1,
      }))
      const nextFlag = new Map(updates.map(update => [update.work.id, update.flag]))
      setWorks(list => list?.map(work => (
        nextFlag.has(work.id) ? { ...work, flag: nextFlag.get(work.id)! } : work
      )) ?? null)

      let writeFailed = false
      let missingCount = 0
      try {
        const saved = await flagWorks(updates.map(update => ({
          id: update.work.id,
          flag: update.flag,
        })))
        missingCount = saved.missing.length
        if (missingCount > 0) {
          const missing = new Set(saved.missing)
          setWorks(list => list?.filter(work => !missing.has(work.id)) ?? null)
          setSelectedIds(ids => ids.filter(id => !missing.has(id)))
        }
      } catch {
        writeFailed = true
        const previous = new Map(updates.map(update => [update.work.id, update.previous]))
        setWorks(list => list?.map(work => (
          previous.has(work.id) ? { ...work, flag: previous.get(work.id)! } : work
        )) ?? null)
      }
      if (seq !== reviewSeqRef.current) return

      const keepCount = verdicts.filter(verdict => verdict.keep).length
      const reviewCount = verdicts.length - keepCount
      const unread = selected.length - rows.length
      setReviewStatus(
        `已复查 ${rows.length} 张：${keepCount} 张建议保留，${reviewCount} 张建议复查。`
        + (unread ? `${unread} 张没读到缩略图。` : '')
        + (missingCount ? `${missingCount} 张已经不在作品集。` : '')
        + (writeFailed ? '标记没存上，再试一次。' : ''),
      )
    } catch (e) {
      if (seq !== reviewSeqRef.current) return
      console.error('智能复查失败', e)
      setReviewStatus('没能检查这组照片，再试一次。')
    } finally {
      if (seq === reviewSeqRef.current) setReviewBusy(false)
    }
  }

  async function saveAlbumEditor() {
    const editor = albumEditor
    if (!editor || albumBusy) return
    const name = editor.value.trim()
    if (!name) {
      setAlbumStatus('相册名不能为空。')
      return
    }
    setAlbumBusy(true)
    setAlbumStatus(null)
    try {
      if (editor.mode === 'create') {
        await createAlbum(name)
        setAlbumStatus(`已创建相册「${name}」。`)
      } else if (albumId !== null) {
        await renameAlbum(albumId, name)
        setAlbumStatus(`相册已改名为「${name}」。`)
      }
      setAlbumEditor(null)
      setAlbumReload(n => n + 1)
    } catch (e) {
      setAlbumStatus(errorText(e, '相册没存上，再试一次'))
    } finally {
      setAlbumBusy(false)
    }
  }

  async function removeCurrentAlbum() {
    if (!activeAlbum || albumBusy) return
    setAlbumBusy(true)
    setAlbumStatus(null)
    try {
      await deleteAlbum(activeAlbum.id)
      setAlbumId(null)
      setAlbumEditor(null)
      setConfirmAlbumDelete(false)
      setAlbumReload(n => n + 1)
      setReload(n => n + 1)
      setAlbumStatus(`已删除相册「${activeAlbum.name}」。照片仍在作品里。`)
    } catch (e) {
      setAlbumStatus(errorText(e, '相册没删掉，再试一次'))
    } finally {
      setAlbumBusy(false)
    }
  }

  /**
   * 相册整组 → 批量处理。
   *
   * 逐张取**原图字节**（不是缩略图），转成 `File` 交给批量工作区；单张取不到
   * 不拖垮整组，取到几张算几张，并把失败张数说清楚。相册超过批量上限时只取
   * 前 `MAX_BATCH_FILES` 张 —— 说的是"前 20 张"，不假装整组都进来了。
   */
  async function startAlbumBatch() {
    if (!activeAlbum || !works || works.length === 0 || albumBatchBusy) return
    const chosen = works.slice(0, MAX_BATCH_FILES)
    setAlbumBatchBusy(true)
    setAlbumStatus(`正在取 ${chosen.length} 张照片…`)
    try {
      const files: File[] = []
      let failedCount = 0
      for (const w of chosen) {
        try {
          const blob = await fetchWorkFullImage(w)
          const mime = blob.type || 'image/jpeg'
          const ext = mime === 'image/png' ? 'png'
            : mime === 'image/webp' ? 'webp'
              : mime === 'image/avif' ? 'avif'
                : 'jpg'
          const stem = (w.alias ?? `作品${w.id}`)
            .replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || `作品${w.id}`
          files.push(new File([blob], `${stem}_${w.id}.${ext}`, { type: mime }))
        } catch (e) {
          failedCount++
          console.error('相册批量处理取图失败', w.id, e)
        }
      }
      if (files.length === 0) {
        setAlbumStatus('这些照片没取回来，再试一次？')
        return
      }
      const parts = [`来自相册「${activeAlbum.name}」`]
      if (works.length > MAX_BATCH_FILES) {
        parts.push(`共 ${works.length} 张，本次先处理前 ${MAX_BATCH_FILES} 张`)
      } else {
        parts.push(`${files.length} 张照片`)
      }
      if (failedCount > 0) parts.push(`${failedCount} 张没取到`)
      setAlbumBatchNote(`${parts.join('，')}。`)
      setAlbumStatus(null)
      setAlbumBatchFiles(files)
      onBatchSeedUsed?.()
      setBatchOpen(true)
    } finally {
      setAlbumBatchBusy(false)
    }
  }

  /** 相册整组 → 原图 ZIP。和选择条里的「下载」共用打包引擎。 */
  async function downloadAlbum() {
    if (!activeAlbum || !works || works.length === 0 || albumDownloading) return
    setAlbumDownloading(true)
    setAlbumStatus('正在取照片…')
    try {
      const result = await downloadWorksZip(works, p => {
        setAlbumStatus(`正在取 ${p.completed} / ${p.total}…`)
      })
      if (result.archive) downloadImage(result.archive, result.archiveName)
      setAlbumStatus(result.failures.length === 0
        ? `已下载 ${result.succeeded} 张。`
        : `下载了 ${result.succeeded} 张，${result.failures.length} 张没取到。`)
    } catch (e) {
      console.error('相册下载没完成', e)
      setAlbumStatus('没下载成，再试一次？')
    } finally {
      setAlbumDownloading(false)
    }
  }

  async function addSelectedToAlbum(targetId: number) {
    if (selectedIds.length === 0 || albumBusy) return
    const album = albums?.find(item => item.id === targetId)
    if (!album) return
    setAlbumBusy(true)
    setAlbumStatus(null)
    try {
      const result = await addWorksToAlbum(targetId, [...selectedIds])
      setAlbumReload(n => n + 1)
      const done = `已把 ${result.added.length} 张加入「${album.name}」`
      setAlbumStatus(result.missing.length > 0
        ? `${done}，${result.missing.length} 张已不在作品里。`
        : `${done}。`)
    } catch (e) {
      setAlbumStatus(errorText(e, '没加进相册，再试一次'))
    } finally {
      setAlbumBusy(false)
    }
  }

  async function removeSelectedFromAlbum() {
    if (!activeAlbum || selectedIds.length === 0 || albumBusy) return
    setAlbumBusy(true)
    setAlbumStatus(null)
    try {
      const result = await removeWorksFromAlbum(activeAlbum.id, [...selectedIds])
      setAlbumReload(n => n + 1)
      setReload(n => n + 1)
      setSelectedIds([])
      const done = `已从「${activeAlbum.name}」移出 ${result.removed.length} 张`
      setAlbumStatus(result.missing.length > 0
        ? `${done}，${result.missing.length} 张本来就不在这个相册。`
        : `${done}。`)
    } catch (e) {
      setAlbumStatus(errorText(e, '没移出相册，再试一次'))
    } finally {
      setAlbumBusy(false)
    }
  }

  async function rate(w: WorkMeta, rating: number) {
    const previous = w.rating
    setWorks(list => list?.map(item => item.id === w.id ? { ...item, rating } : item) ?? null)
    try {
      const got = await rateWork(w.id, rating)
      setWorks(list => list?.map(item => item.id === w.id ? { ...item, rating: got.rating } : item) ?? null)
      setDelFailed(null)
    } catch (e) {
      setWorks(list => list?.map(item => item.id === w.id ? { ...item, rating: previous } : item) ?? null)
      setDelFailed(errorText(e, '评分没存上，再试一次'))
    }
  }

  async function mark(w: WorkMeta, flag: WorkMeta['flag']) {
    const previous = w.flag
    setWorks(list => list?.map(item => item.id === w.id ? { ...item, flag } : item) ?? null)
    try {
      const got = await flagWork(w.id, flag)
      setWorks(list => list?.map(item => item.id === w.id ? { ...item, flag: got.flag } : item) ?? null)
      setDelFailed(null)
    } catch (e) {
      setWorks(list => list?.map(item => item.id === w.id ? { ...item, flag: previous } : item) ?? null)
      setDelFailed(errorText(e, '标记没存上，再试一次'))
    }
  }

  async function markColor(w: WorkMeta, color: WorkColor) {
    const previous = w.color ?? 'none'
    setWorks(list => list?.map(item => item.id === w.id ? { ...item, color } : item) ?? null)
    try {
      const got = await colorWork(w.id, color)
      setWorks(list => list?.map(item => item.id === w.id
        ? { ...item, color: got.color ?? color } : item) ?? null)
      setDelFailed(null)
    } catch (e) {
      setWorks(list => list?.map(item => item.id === w.id
        ? { ...item, color: previous } : item) ?? null)
      setDelFailed(errorText(e, '颜色标签没存上，再试一次'))
    }
  }

  /** 一格作品 —— 按天分组和按大小两处共用（`showSize` 只在按大小那一档开）。 */
  function workCell(w: WorkMeta, showSize = false) {
    const name = sort === 'time' && timeBasis === 'shot'
      ? workNameAt(w, now, shotTime(w))
      : workName(w, now)
    return (
      <div key={w.id} className="gallery-item">
        {/* ⚠️ 选择模式里点整格 = **勾选，不是打开**（微信式：那一档里没有
            "进去看看"这回事）。 */}
        <button className="gallery-cell"
          onClick={() => (selecting ? togglePick(w.id) : onOpen(w.id))}>
          {/* loading="lazy"：60 张不用一次全下载 */}
          <img className="gallery-thumb" src={fileUrl(w)} alt={name} loading="lazy" />
          <span className="gallery-name">{name}</span>
          {showSize && <span className="gallery-size">{formatSize(w.bytes)}</span>}
        </button>
        {!selecting && (
          <button
            type="button"
            className="gallery-loupe"
            aria-label={`全屏看 ${name}`}
            title="全屏看片"
            onClick={() => openLoupe(w)}
          >
            <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {!selecting && w.flag !== 0 && (
          <span className={`gallery-flag ${w.flag === 1 ? 'pick' : 'reject'}`}>
            {w.flag === 1 ? '保留' : '排除'}
          </span>
        )}
        {!selecting && w.color && w.color !== 'none' && (
          <span
            className={`gallery-color color-${w.color}`}
            aria-label={`颜色标签：${WORK_COLOR_LABELS[w.color]}`}
            title={`颜色标签：${WORK_COLOR_LABELS[w.color]}`}
          />
        )}
        {/* ★ 选择模式里那颗勾选框。⚠️ 它**不能放进 button 里**（HTML 不允许交互
            元素套交互元素）—— 它是格子的**兄弟**，绝对定位压在图的左上角。
            系统原生那款（和对话列表同一款），颜色跟主色走。 */}
        {selecting && (
          <input type="checkbox" className="gallery-pick"
            checked={selectedIds.includes(w.id)}
            disabled={deleting || downloading || ratingBusy || colorBusy}
            onChange={() => togglePick(w.id)}
            aria-label="选中这张作品" />
        )}
        {!selecting && (
          <div className="gallery-rating">
            <RatingStars value={w.rating ?? 0} label={`${name} 星级`}
              onChange={rating => void rate(w, rating)} />
          </div>
        )}
      </div>
    )
  }

  function stackCell(entry: Extract<GalleryEntry<WorkMeta>, { kind: 'stack' }>) {
    const open = expandedStacks.includes(entry.key)
    const regionId = `gallery-${entry.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const shotAt = (work: WorkMeta) => (
      typeof work.capturedAt === 'number' && work.capturedAt > 0
        ? work.capturedAt
        : work.createdAt
    )
    const firstAt = Math.min(...entry.works.map(shotAt))
    const lastAt = Math.max(...entry.works.map(shotAt))
    const range = firstAt === lastAt
      ? burstClock(firstAt)
      : `${burstClock(firstAt)}–${burstClock(lastAt)}`
    const allSelected = selecting
      && entry.works.every(work => selectedIds.includes(work.id))

    return (
      <article
        key={entry.key}
        className={`gallery-stack${open ? ' expanded' : ''}`}
        aria-label={`连拍组，共 ${entry.works.length} 张`}
      >
        <div className="gallery-stack-summary">
          <button
            type="button"
            className="gallery-stack-trigger"
            aria-expanded={open}
            aria-controls={regionId}
            aria-label={`${open ? '收起' : '展开'}连拍组，${entry.works.length} 张，${range}`}
            onClick={() => toggleStack(entry.key)}
          >
            <span className="gallery-stack-art">
              <img
                className="gallery-stack-cover"
                src={fileUrl(entry.cover)}
                alt={workName(entry.cover, now)}
                loading="lazy"
              />
              <span className="gallery-stack-count">{entry.works.length} 张</span>
            </span>
            <span className="gallery-stack-copy">
              <span className="gallery-stack-title">
                <Layers3 size={14} strokeWidth={1.5} aria-hidden="true" />
                连拍组
              </span>
              <span className="gallery-stack-meta">{range}</span>
              <span className="gallery-stack-hint">
                {open ? '收起，回到作品墙' : '同一段连拍，展开看每一张'}
              </span>
            </span>
            <ChevronDown
              className="gallery-stack-chevron"
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </button>
          <div className="gallery-stack-actions">
            <button
              type="button"
              className="gallery-stack-select"
              aria-pressed={allSelected}
              onClick={() => toggleStackSelection(entry.works, entry.key)}
            >
              {allSelected ? '取消整组' : '多选整组'}
            </button>
            <button
              type="button"
              className="gallery-stack-best"
              disabled={bestBusy || similarBusy || deleting || downloading
                || ratingBusy || colorBusy || albumBusy}
              onClick={() => chooseBestInStack(entry.works, entry.key)}
            >
              {bestBusy ? '正在比较…' : '整组挑最好'}
            </button>
          </div>
        </div>
        <div
          id={regionId}
          className="gallery-stack-expanded"
          hidden={!open}
        >
          {open && (
            <>
              <div className="gallery-stack-expanded-head">
                <span>这一组 {entry.works.length} 张</span>
                <span>{range} 拍摄</span>
              </div>
              <div className="gallery-grid">
                {entry.works.map(work => workCell(work))}
              </div>
            </>
          )}
        </div>
      </article>
    )
  }

  if (idPhotoOpen) {
    return <LazyWorkflow><IdPhotoPanel onBack={() => setIdPhotoOpen(false)} /></LazyWorkflow>
  }
  if (printOpen) {
    return <LazyWorkflow><PrintPanel onBack={() => setPrintOpen(false)} /></LazyWorkflow>
  }
  if (batchOpen) {
    return (
      <LazyWorkflow>
        <BatchPanel
          onBack={() => {
            setBatchOpen(false)
            setAlbumBatchFiles(null)
            setAlbumBatchNote(null)
            onBatchSeedUsed?.()
          }}
          currentParams={currentParams}
          initialPresetId={defaultStyleId}
          initialFiles={albumBatchFiles ?? batchSeed ?? undefined}
          sourceNote={albumBatchNote}
        />
      </LazyWorkflow>
    )
  }
  if (collageOpen) {
    return <LazyWorkflow><CollagePanel onBack={() => setCollageOpen(false)} /></LazyWorkflow>
  }
  if (panoramaOpen) {
    return <LazyWorkflow><PanoramaPanel onBack={() => setPanoramaOpen(false)} /></LazyWorkflow>
  }
  if (hdrOpen) {
    return (
      <LazyWorkflow>
        <HdrPanel
          onBack={() => { setHdrOpen(false); setHdrInitial(null) }}
          initialFiles={hdrInitial ?? undefined}
        />
      </LazyWorkflow>
    )
  }
  if (longExposureOpen) {
    return (
      <LazyWorkflow>
        <LongExposurePanel onBack={() => setLongExposureOpen(false)} />
      </LazyWorkflow>
    )
  }
  if (focusOpen) {
    return (
      <LazyWorkflow>
        <FocusStackPanel
          onBack={() => { setFocusOpen(false); setFocusInitial(null) }}
          initialFiles={focusInitial ?? undefined}
        />
      </LazyWorkflow>
    )
  }
  if (gridOpen) {
    return <LazyWorkflow><GridSplitPanel onBack={() => setGridOpen(false)} /></LazyWorkflow>
  }
  if (longImageOpen) {
    return <LazyWorkflow><LongImagePanel onBack={() => setLongImageOpen(false)} /></LazyWorkflow>
  }
  if (gifOpen) {
    return <LazyWorkflow><GifPanel onBack={() => setGifOpen(false)} /></LazyWorkflow>
  }
  if (videoOpen) {
    return (
      <LazyWorkflow>
        <VideoPanel
          initialFiles={videoSeed ?? undefined}
          onSeedUsed={() => onVideoSeedUsed?.()}
          onBack={() => { setVideoOpen(false); onVideoSeedUsed?.() }}
        />
      </LazyWorkflow>
    )
  }
  if (movieOpen) {
    return <LazyWorkflow><PhotoMoviePanel onBack={() => setMovieOpen(false)} /></LazyWorkflow>
  }
  if (posterOpen) {
    return <LazyWorkflow><PosterPanel onBack={() => setPosterOpen(false)} /></LazyWorkflow>
  }

  const emptyWorks = works !== null && works.length === 0
  const toolsCollapsed = !selecting && emptyWorks && !emptyToolsOpen

  return (
    <section className={`gallery${emptyWorks ? ' gallery-empty-mode' : ''}`}>
      <header className="gallery-head">
        <div className="gallery-head-main">
          <div className="gallery-title-block">
            <h1 className="gallery-title">我的作品</h1>
            {works && <span className="gallery-title-meta">{works.length} 张作品</span>}
          </div>
          {/* ⚠️ 2026-10-01：这一格**故意没过 `<Field>`**。它没有标签、没有注解、也没有
              错误提示，包一层只为了给它一个名字的话，`.gallery-search` 身上那条
              `flex: 1` 就得从输入框挪到外层那个 div 上（`.gallery-head` 是 flex 行，
              孩子换人了整行就得重量）—— 换不到任何东西。
              可访问的名字**直接给在输入框上**：placeholder 只是提示，读屏软件不保证念它。 */}
          <input className="gallery-search" value={q} placeholder="找一张…（名字、日期、文件名、相机或镜头）"
                 aria-label="找一张作品"
                 onChange={e => { setQ(e.target.value); resetLimit() }} />
          {emptyWorks && !selecting && (
            <button
              type="button"
              className="gallery-tools-toggle"
              aria-expanded={emptyToolsOpen}
              aria-controls="gallery-workbench"
              onClick={() => setEmptyToolsOpen(open => !open)}
            >
              {emptyToolsOpen ? '收起工具' : '创作工具'}
              <ChevronDown
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
                className={emptyToolsOpen ? 'open' : undefined}
              />
            </button>
          )}
        </div>
        {!selecting && (
          <section
            id="gallery-workbench"
            className={`gallery-workbench${toolsCollapsed ? ' empty-collapsed' : ''}`}
            aria-label="创作工具"
          >
            <div className="gallery-tool-group">
              <h2 className="gallery-tool-group-title">批处理</h2>
              <div className="gallery-tool-list">
                <button className="gallery-batch" onClick={() => setBatchOpen(true)}>
                  批量处理
                </button>
              </div>
            </div>
            <div className="gallery-tool-group">
              <h2 className="gallery-tool-group-title">版式</h2>
              <div className="gallery-tool-list">
                <button className="gallery-collage" onClick={() => setIdPhotoOpen(true)}>
                  证件照
                </button>
                <button className="gallery-idphoto" onClick={() => setCollageOpen(true)}>
                  拼图
                </button>
                <button className="gallery-print" onClick={() => setPrintOpen(true)}>
                  打印排版
                </button>
                <button className="gallery-poster" onClick={() => setPosterOpen(true)}>
                  社交封面
                </button>
              </div>
            </div>
            <div className="gallery-tool-group">
              <h2 className="gallery-tool-group-title">合成</h2>
              <div className="gallery-tool-list">
                <button className="gallery-grid" onClick={() => setGridOpen(true)}>
                  九宫格
                </button>
                <button className="gallery-longimage" onClick={() => setLongImageOpen(true)}>
                  长图
                </button>
                <button className="gallery-panorama" onClick={() => setPanoramaOpen(true)}>
                  全景
                </button>
                <button className="gallery-hdr" onClick={() => setHdrOpen(true)}>
                  HDR 合成
                </button>
                <button className="gallery-long" onClick={() => setLongExposureOpen(true)}>
                  长曝光
                </button>
                <button className="gallery-focus" onClick={() => setFocusOpen(true)}>
                  焦点堆栈
                </button>
              </div>
            </div>
            <div className="gallery-tool-group">
              <h2 className="gallery-tool-group-title">动态</h2>
              <div className="gallery-tool-list">
                <button className="gallery-gif" onClick={() => setGifOpen(true)}>
                  照片动图
                </button>
                <button className="gallery-video" onClick={() => setVideoOpen(true)}>
                  短片调色
                </button>
                <button className="gallery-movie" onClick={() => setMovieOpen(true)}>
                  照片电影
                </button>
              </div>
            </div>
          </section>
        )}
        {/* ★ 2026-10-10：排序切换 + 「多选」。
            · 排序那颗写的是**目标**（现在是按时间的，它写「按大小」）——
              点一下就切过去，比写当前态少一层猜；
            · 选择模式开着、或者压根没有作品时两颗都收掉（不留点了没用的按钮，
              和对话列表"那一档里辅助条全收"同一条规矩）。 */}
        {!selecting && works && works.length > 0 && (
          <div className="gallery-view-tools" role="group" aria-label="筛选和排序">
            <label className="gallery-rating-filter">
              <span>星级</span>
              <select
                aria-label="按星级筛选"
                value={minRating}
                onChange={e => {
                  setMinRating(Number(e.target.value))
                  resetLimit()
                }}
              >
                <option value={0}>全部</option>
                <option value={1}>有评分</option>
                <option value={3}>3 星以上</option>
                <option value={4}>4 星以上</option>
                <option value={5}>5 星</option>
              </select>
            </label>
            <label className="gallery-rating-filter">
              <span>标记</span>
              <select
                aria-label="按标记筛选"
                value={flagFilter}
                onChange={e => {
                  setFlagFilter(e.target.value as 'all' | 'pick' | 'reject')
                  resetLimit()
                }}
              >
                <option value="all">全部</option>
                <option value="pick">保留</option>
                <option value="reject">排除</option>
              </select>
            </label>
            <label className="gallery-rating-filter">
              <span>颜色</span>
              <select
                aria-label="按颜色筛选"
                value={colorFilter}
                onChange={e => {
                  setColorFilter(e.target.value as WorkColor | 'all')
                  resetLimit()
                }}
              >
                <option value="all">全部</option>
                {WORK_COLORS.map(color => (
                  <option key={color} value={color}>
                    {color === 'none' ? '无标色' : WORK_COLOR_LABELS[color]}
                  </option>
                ))}
              </select>
            </label>
            {(gearOptions.cameras.length > 0 || gearOptions.lenses.length > 0) && (
              <label className="gallery-rating-filter">
                <span>器材</span>
                <select
                  aria-label="按器材筛选"
                  value={gearFilter}
                  onChange={e => {
                    setGearFilter(e.target.value)
                    resetLimit()
                  }}
                >
                  <option value="all">全部</option>
                  {gearOptions.cameras.length > 0 && (
                    <optgroup label="机身">
                      {gearOptions.cameras.map(([name, count]) => (
                        <option key={`camera:${name}`} value={`camera:${name}`}>
                          {name}（{count}）
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {gearOptions.lenses.length > 0 && (
                    <optgroup label="镜头">
                      {gearOptions.lenses.map(([name, count]) => (
                        <option key={`lens:${name}`} value={`lens:${name}`}>
                          {name}（{count}）
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            )}
            <button className="gallery-sort"
                    onClick={() => setSort(s => (s === 'size' ? 'time' : 'size'))}>
              {sort === 'size' ? '按时间' : '按大小'}
            </button>
            {sort === 'time' && hasCapturedTime && (
              <button
                type="button"
                className="gallery-time-basis"
                aria-pressed={timeBasis === 'shot'}
                aria-label={timeBasis === 'shot'
                  ? '切换为按最近编辑时间分组'
                  : '切换为按拍摄时间分组'}
                onClick={() => {
                  setTimeBasis(value => (value === 'shot' ? 'edited' : 'shot'))
                  resetLimit()
                }}
              >
                <Clock3 size={14} strokeWidth={1.5} aria-hidden="true" />
                {timeBasis === 'shot' ? '按编辑' : '按拍摄'}
              </button>
            )}
            {sort === 'time' && burstDays.stackCount > 0 && (
              <button
                type="button"
                className="gallery-bursts"
                aria-pressed={burstStacking}
                aria-label={burstStacking ? '展开所有连拍组' : '合并连拍组'}
                onClick={() => setBurstStacking(value => !value)}
              >
                <Layers3 size={14} strokeWidth={1.5} aria-hidden="true" />
                连拍组 · {burstDays.stackCount}
              </button>
            )}
            <button className="gallery-multi"
                    onClick={() => beginSelect()}>多选</button>
          </div>
        )}
      </header>

      {!selecting && (
        <section className="gallery-albums" aria-label="相册">
          <label>
            <span>相册</span>
            <select
              aria-label="按相册筛选"
              value={albumId ?? ''}
              disabled={albumBusy || albums === null}
              onChange={e => {
                setAlbumId(e.target.value ? Number(e.target.value) : null)
                setAlbumStatus(null)
                resetLimit()
              }}
            >
              <option value="">全部作品</option>
              {(albums ?? []).map(album => (
                <option key={album.id} value={album.id}>
                  {album.name}（{album.workCount}）
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={albumBusy}
            onClick={() => { setAlbumStatus(null); setAlbumEditor({ mode: 'create', value: '' }) }}>
            新建相册
          </button>
          {activeAlbum && albumEditor?.mode !== 'rename' && (
            <button type="button" disabled={albumBusy}
              onClick={() => setAlbumEditor({ mode: 'rename', value: activeAlbum.name })}>
              重命名
            </button>
          )}
          {activeAlbum && (
            <button type="button" className="danger" disabled={albumBusy}
              onClick={() => setConfirmAlbumDelete(true)}>
              删除相册
            </button>
          )}
          {activeAlbum && (
            <>
              <button
                type="button"
                className="gallery-album-batch"
                disabled={albumBusy || albumBatchBusy || !works || works.length === 0}
                onClick={() => void startAlbumBatch()}
              >{albumBatchBusy ? '正在取照片…' : '批量处理相册'}</button>
              <button
                type="button"
                className="gallery-album-download"
                disabled={albumBusy || albumDownloading || !works || works.length === 0}
                onClick={() => void downloadAlbum()}
              >{albumDownloading ? '正在打包…' : '下载相册'}</button>
            </>
          )}
          {albumEditor && (
            <form className="gallery-album-editor"
              onSubmit={e => { e.preventDefault(); void saveAlbumEditor() }}>
              <input
                autoFocus
                aria-label={albumEditor.mode === 'create' ? '新相册名' : '相册新名字'}
                value={albumEditor.value}
                maxLength={40}
                placeholder={albumEditor.mode === 'create' ? '给这个相册起个名字' : '相册新名字'}
                onChange={e => setAlbumEditor({ ...albumEditor, value: e.target.value })}
              />
              <Btn type="submit" disabled={albumBusy || !albumEditor.value.trim()}>保存</Btn>
              <button type="button" disabled={albumBusy}
                onClick={() => setAlbumEditor(null)}>取消</button>
            </form>
          )}
          {confirmAlbumDelete && activeAlbum && (
            <div className="gallery-album-confirm" role="alert">
              <span>删掉相册「{activeAlbum.name}」？照片不会删。</span>
              <button type="button" className="danger" disabled={albumBusy}
                onClick={() => void removeCurrentAlbum()}>确认删除</button>
              <button type="button" disabled={albumBusy}
                onClick={() => setConfirmAlbumDelete(false)}>算了</button>
            </div>
          )}
          {albumStatus && <span className="gallery-album-status" role="status">{albumStatus}</span>}
        </section>
      )}

      {failed && (
        /* ★ 2026-10-11（设计跟进 Task 2）：错误态就是**整页那一件**（居中 +
            一颗能点的出口），不再是"左上角一行红字 + 一句空话"。
            换掉的那句话是「刷新一下页面，再试一次。」—— 它把出路全押在
            **整页刷新**上：用户在这一屏之外的东西（还没存的那张照片）会被
            一起冲掉，而我们明明可以只把这一趟请求重跑一遍。
            旧口径说"§3.7 要的是告诉用户怎么办，而刷新是用户本来就会的"——
            现在按钮替他把那句话说完了，而且是真的做了那件事。 */
        <ErrorState text={failed} onRetry={retry} />
      )}
      {/* ★ 2026-10-10：删失败那一句只加在列表**上面**，名单原样（照 SessionsPage）。 */}
      {delFailed && <p className="gallery-error">{delFailed}</p>}
      {!works && !failed && <p className="gallery-loading">正在打开…</p>}

      {works && works.length === 0 && albumId !== null && (
        <div className="gallery-empty empty-state">
          <p className="gallery-empty-title">这个相册还没有照片。</p>
          <Btn onClick={() => { setAlbumId(null); resetLimit() }}>回到全部作品</Btn>
        </div>
      )}

      {works && works.length === 0 && albumId === null && (
        /* ★ 2026-10-11（设计跟进 T5）：出路从"指方位的一句话"（「左边点「修图」，
            做一张试试。」）换成和对话列表空态**同款**的一颗按钮 —— 窄屏上左栏
            在底下，"左边"指的是错的方向；一颗真能点的按钮不受版面影响。
            `empty-state` 那个类带着 `Btn` 要的那点间距和药丸形（和
            `.sessions-empty` 同一份，别在这儿各写一份）。
            ⚠️ 主句的类名不是多余的：CSS 里"整屏看上去只是'没加载出来'"那句
            就是为它写的，别顺手删。 */
        <div className="gallery-empty empty-state">
          <div className="gallery-empty-frame" aria-hidden="true">
            <span />
          </div>
          <div className="gallery-empty-copy">
            <p className="gallery-empty-title">还没有作品。</p>
            <p className="gallery-empty-note">选一张照片开始修，存下来后会出现在这里。</p>
            {/* §3.7：告诉用户"不行"的地方，都要同时告诉他"那怎么办" */}
            <Btn onClick={onNew}>去改一张</Btn>
          </div>
        </div>
      )}

      {sort === 'size' ? (
        /* ★ 2026-10-10 按大小：**不分天、不分页**（分页是给"按时间翻旧账"用的；
           这一档是"一眼找最大的"，一次全摆出来 —— 图本来就 lazy）。 */
        <>
          {works && sizeList.length === 0 && (
            <p className="gallery-none">没找到。换个字试试？</p>
          )}
          {sizeList.length > 0 && (
            <div className="gallery-day">
              <h2 className="gallery-day-title">按大小 · {sizeList.length} 张</h2>
              <div className="gallery-grid">
                {sizeList.map(w => workCell(w, true))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {works && works.length > 0 && groups.length === 0 && (
            <p className="gallery-none">没找到。换个字试试？</p>
          )}

          {shown.map(g => (
            <div key={g.day} className="gallery-day">
              {/* 标题上的张数是**这一天的全部张数**，和下面摆出来的数量一致 ——
                  这也是 visibleGroups 按天取整的理由 */}
              <h2 className="gallery-day-title">
                {timeBasis === 'shot' ? `拍摄于 ${g.label}` : g.label} · {g.works.length} 张
              </h2>
              <div className="gallery-grid">
                {burstStacking
                  ? (burstDays.entries.get(g.day) ?? []).map(entry => (
                    entry.kind === 'stack' ? stackCell(entry) : workCell(entry.work)
                  ))
                  : g.works.map(w => workCell(w))}
              </div>
            </div>
          ))}

          {/* ⚠️ 那个圈**必须转**：没有它，用户会以为到底了（§3.5） */}
          {more && <div ref={sentinel} className="gallery-more">正在取…</div>}
          {!more && groups.length > 0 && <p className="gallery-end">没有更多了</p>}
        </>
      )}

      {/* ★ 2026-10-10：选择模式底下那条操作条（和对话列表**同一个组件** ——
          这一页只是操作对象是"张"、scope 是 `gallery`）。
          它是 `.gallery`（滚动区）的最后一个孩子 + sticky 吸底。 */}
      {selecting && (
        <SelectBar scope="gallery" count={selectedIds.length}
          busy={deleting || downloading || ratingBusy || colorBusy || similarBusy
            || bestBusy || reviewBusy || albumBusy} unit="张"
          ratingSlot={(
            <div className="gallery-bulk-rate">
              <span className="gallery-bulk-rate-label">星级</span>
              <RatingStars
                value={selectedRating}
                label="批量星级"
                disabled={ratingBusy || colorBusy || similarBusy || bestBusy || reviewBusy
                  || selectedIds.length === 0}
                onChange={rating => void rateSelected(rating)}
              />
              <button
                type="button"
                className="gallery-bulk-rate-clear"
                disabled={ratingBusy || colorBusy || similarBusy || bestBusy || reviewBusy
                  || selectedIds.length === 0}
                onClick={() => void rateSelected(0)}
              >
                清除
              </button>
              <label className="gallery-bulk-color">
                <span>颜色</span>
                <select
                  aria-label="批量颜色标签"
                  value={selectedColor ?? ''}
                  disabled={colorBusy || ratingBusy || albumBusy || similarBusy
                    || bestBusy || reviewBusy || selectedIds.length === 0}
                  onChange={e => {
                    const color = e.target.value as WorkColor
                    if (color) void paintSelected(color)
                  }}
                >
                  <option value="" disabled>混合</option>
                  {WORK_COLORS.map(color => (
                    <option key={color} value={color}>
                      {color === 'none' ? '清除' : WORK_COLOR_LABELS[color]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          albumSlot={(
            <div className="gallery-bulk-album">
              <button
                type="button"
                aria-label="找相似照片"
                disabled={similarBusy || bestBusy || reviewBusy || deleting || downloading
                  || ratingBusy || colorBusy || albumBusy || selectedIds.length !== 1}
                onClick={() => void selectSimilar()}
              >{similarBusy ? '正在比较…' : '找相似'}</button>
              <button
                type="button"
                aria-label="从选中里挑最好"
                disabled={bestBusy || similarBusy || reviewBusy || deleting || downloading
                  || ratingBusy || colorBusy || albumBusy || selectedIds.length < 2}
                onClick={() => void chooseBest()}
              >{bestBusy ? '正在评分…' : '挑最好'}</button>
              <button
                type="button"
                aria-label="对比选中的两张"
                disabled={selectedIds.length !== 2 || deleting || downloading || reviewBusy}
                onClick={compareSelected}
              >对比两张</button>
              <button
                type="button"
                aria-label="智能复查选中"
                disabled={reviewBusy || bestBusy || similarBusy || deleting || downloading
                  || ratingBusy || colorBusy || albumBusy || selectedIds.length < 2}
                onClick={() => void reviewSelected()}
              >{reviewBusy ? '正在复查…' : '智能复查'}</button>
              {(albums?.length ?? 0) > 0 ? (
                <select
                  aria-label="加入相册"
                  value=""
                  disabled={albumBusy || ratingBusy || colorBusy || similarBusy
                    || bestBusy || reviewBusy || selectedIds.length === 0}
                  onChange={e => {
                    const id = Number(e.target.value)
                    if (id) void addSelectedToAlbum(id)
                  }}
                >
                  <option value="">加入相册…</option>
                  {albums!.map(album => (
                    <option key={album.id} value={album.id}>{album.name}</option>
                  ))}
                </select>
              ) : (
                <span className="gallery-bulk-album-hint">先退出多选，新建一个相册</span>
              )}
              {activeAlbum && (
                <button type="button"
                  disabled={albumBusy || ratingBusy || colorBusy || similarBusy
                    || bestBusy || reviewBusy || selectedIds.length === 0}
                  onClick={() => void removeSelectedFromAlbum()}>
                  移出相册
                </button>
              )}
            </div>
          )}
          onDownload={() => void doBatchDownload()}
          downloading={downloading}
          status={albumStatus ?? ratingStatus ?? colorStatus ?? similarStatus
            ?? bestStatus ?? reviewStatus ?? downloadStatus}
          askNote={confirmAsk ? `删掉选中的 ${selectedIds.length} 张？删了就找不回来了。` : null}
          onAsk={() => setConfirmAsk(true)}
          onConfirm={() => void doBatchDelete()}
          onExitAsk={() => setConfirmAsk(false)}
          onExit={exitSelect} />
      )}

      {loupe && loupeWorks.length > 0 && (
        <CullingLightbox
          works={loupeWorks}
          index={loupeIndex}
          now={now}
          onIndex={moveLoupe}
          onRate={(work, rating) => void rate(work, rating)}
          onFlag={(work, flag) => void mark(work, flag)}
          onColor={(work, color) => void markColor(work, color)}
          onOpen={id => { setLoupe(null); onOpen(id) }}
          onClose={() => setLoupe(null)}
          initialCompare={loupe.compare}
        />
      )}
    </section>
  )
}
