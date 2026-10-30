import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Recipe } from '../../shared/works.ts'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import type { EditLayer } from '../../shared/layers.ts'
import { createWork, replaceWork } from '../api/works'
import { errorText } from '../api/client'
import {
  blobToDataUrl, buildExportBlob, buildFilename, canCopyImage, copyImage,
  canShareFile, cropRectForAspect, downloadImage, exportSize, markExportCanvas,
  shareFile, shareImage,
  DEFAULT_EXPORT_OPTIONS,
  type ExportAspect, type ExportColorSpace, type ExportFit, type ExportFormat,
  type ExportOptions,
} from '../export/save'
import { expandCanvas } from '../export/expand'
import { expandedSize } from '../export/expand'
import {
  loadTextWatermark, loadWatermarkLogo, saveTextWatermark,
  type WatermarkLogo, type WatermarkOptions,
} from '../image/watermark'
import {
  loadExportDefaults, normalizeExportDefaults, saveExportDefaults as persistExportDefaults,
} from '../export/prefs'
import { GALLERY_THUMB_MAX_SIDE, makeThumbnail } from '../core/thumbnail'
import { makeCanvas } from '../core/canvas'
import type { ChatMessage } from '../ui/ChatPanel'
import { drawEditLayers } from '../image/layers'
import { preloadStickerImages } from '../image/sticker'
import { getHeicCapability } from '../export/heicCapability'
import { buildSocialExportZip } from '../export/social'
import { readLensInfo } from '../core/photoInfo'
import type { LivePhotoEvidence, LivePhotoPair } from '../core/livePhoto'
import { buildLivePhotoBundle } from '../export/livePhotoBundle'

/**
 * **把成品交到用户手上**那一整件事：导出、分享、下载到电脑、存进作品集，
 * 以及"上次那张要替换掉吗"。
 *
 * 2026-10-02 从 `App.tsx` 里整段搬出来的（原文照搬，注释一条没丢）——
 * 它在那边是 1419~1622 行，两百多行挤在一个两千行的组件里，
 * 而它跟"修图"本身没关系：**图已经改好了，这一段只管怎么交出去**。
 *
 * ⚠️ **搬的时候依赖数组一个都没改**。这几条 `useCallback` 的依赖数组是
 *    踩过坑才长成这样的（尤其 `onSave` 的 `savedId`、`saveOnce` 的 `recipeNow`），
 *    看着"多了一项少了一项无所谓"就是下一次静默失灵的开始。
 */

export type DeliveryDeps = {
  /** 屏幕上那块画布 —— 导出走的就是它（`buildExportBlob` 拿它 + 原文件重编码） */
  canvasEl: RefObject<HTMLCanvasElement | null>
  /** 用户选的那张原文件。**它决定导出保不保 EXIF/全分辨率**，没有它就不导出 */
  originalFile: RefObject<File | null>
  /** 这一趟（同一张照片）上一次存进去的是哪个作品。非 null ⇒ 保存时要问一句 */
  savedId: number | null
  setSavedId: (id: number) => void
  /** 配方里的两半：参数 + 用户说过的原话 */
  params: Adjustments
  /** 当前这一版的文字层（★ 2026-10-19）；导出时画进成片。 */
  layers: EditLayer[]
  messages: readonly ChatMessage[]
  /** ★ 2026-10-05（滤镜，T12）：配方里的第三样 —— 这张照片正用着哪个滤镜。
   *  ⚠️ 存进配方时只留**名字**（id 对已经烤好的图没有意义，见 `shared/works.ts`），
   *  而名字得从清单里现查（id → 名字），所以清单也要一并给它。 */
  lut: LutRef | null
  luts: readonly LutMeta[]
  /** 通报一句"没成"（顶栏那条，留着等用户看完） */
  noticeBad: (text: string) => void
  /** 通报一句"成了"（顶栏那条，几秒后自己走） */
  noticeOk: (text: string) => void
  /** 账号级偏好（`/api/me` 带回的 JSON）；登录后覆盖本机默认值。 */
  accountPreferences?: Record<string, unknown> | null
  /** 把偏好同步到账号；失败时本机值仍然有效。 */
  saveAccountPreferences?: (preferences: Record<string, unknown>) => Promise<unknown>
  /** 当前正在编辑的 Apple 实况照片；普通照片为 null。 */
  livePhotoPair?: LivePhotoPair | null
  /** 导入时核对过的 Apple 标识；只有 verified 才允许打兼容包。 */
  livePhotoEvidence?: LivePhotoEvidence | null
  /** 登录后才探测需要鉴权的导出能力；登录页不该先撞一条必然 401 的请求。 */
  enabled?: boolean
}

export function useDelivery(deps: DeliveryDeps) {
  const {
    canvasEl, originalFile, savedId, setSavedId, params, layers, messages, lut, luts,
    noticeBad, noticeOk, accountPreferences, saveAccountPreferences,
    livePhotoPair = null, livePhotoEvidence = null, enabled = true,
  } = deps

  /** 正在导出的是哪一个按钮（null = 没在忙）。几个按钮共用一个"忙"，
   *  所以同一时刻只可能有一个在转。 */
  const [delivering, setDelivering] =
    useState<'share' | 'download' | 'save' | 'copy' | 'platforms' | 'live' | null>(null)
  const [copySupported] = useState(canCopyImage)
  const [canShareArchive] = useState(() =>
    canShareFile(new Blob([], { type: 'application/zip' }), 'probe.zip'))
  const [heicSupported, setHeicSupported] = useState(false)

  /** 「把图给我」那两条例外才用的格式 / 压缩率 / 尺寸；存进作品集仍走 JPEG 原图。 */
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => loadExportDefaults())
  const [exportWatermark, setExportWatermark] = useState<WatermarkOptions>(loadTextWatermark)
  /** 自定义文件名只对**这一张原图**有效；换照片后自动回默认命名。 */
  const [exportFilenameFor, setExportFilenameFor] =
    useState<{ file: File; name: string } | null>(null)
  const [exportLogo, setExportLogo] = useState<WatermarkLogo | null>(null)
  const exportLogoRef = useRef<WatermarkLogo | null>(null)
  const accountPrefsKeyRef = useRef('')

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void getHeicCapability().then(capability => {
      if (!alive) return
      setHeicSupported(capability.available)
      if (!capability.available) {
        setExportOptions(o => o.format === 'image/heic'
          ? { ...o, format: 'image/jpeg' }
          : o)
      }
    })
    return () => { alive = false }
  }, [enabled])

  useEffect(() => {
    const key = accountPreferences ? JSON.stringify(accountPreferences) : ''
    if (key === accountPrefsKeyRef.current) return
    accountPrefsKeyRef.current = key
    if (accountPreferences && typeof accountPreferences.export === 'object') {
      setExportOptions(normalizeExportDefaults(accountPreferences.export))
    }
  }, [accountPreferences])

  useEffect(() => () => {
    exportLogoRef.current?.close?.()
    exportLogoRef.current = null
  }, [])

  const pickExportLogo = useCallback(async (file: File | null) => {
    const next = file ? await loadWatermarkLogo(file) : null
    exportLogoRef.current?.close?.()
    exportLogoRef.current = next
    setExportLogo(next)
    if (file) setExportWatermark(w => ({ ...w, kind: 'logo' }))
  }, [])
  const updateExportWatermark = useCallback((next: WatermarkOptions) => {
    setExportWatermark(next)
    saveTextWatermark(next)
  }, [])
  const setExportFormat = useCallback((format: ExportFormat) => {
    setExportOptions(o => ({ ...o, format }))
  }, [])
  const setExportQuality = useCallback((qualityPct: number) => {
    const q = Number.isFinite(qualityPct) ? Math.round(qualityPct) : DEFAULT_EXPORT_OPTIONS.qualityPct
    setExportOptions(o => ({ ...o, qualityPct: Math.max(60, Math.min(100, q)) }))
  }, [])
  const setExportLongEdge = useCallback((longEdge: number | null) => {
    setExportOptions(o => ({
      ...o,
      longEdge: longEdge === null || !Number.isFinite(longEdge) || longEdge <= 0 ? null : longEdge,
    }))
  }, [])
  const setExportAspect = useCallback((aspect: ExportAspect) => {
    setExportOptions(o => ({ ...o, aspect }))
  }, [])
  const setExportFit = useCallback((fit: ExportFit) => {
    setExportOptions(o => ({ ...o, fit }))
  }, [])
  const setExportMetadata = useCallback((preserveMetadata: boolean) => {
    setExportOptions(o => ({ ...o, preserveMetadata }))
  }, [])
  const setExportLocation = useCallback((preserveLocation: boolean) => {
    setExportOptions(o => ({ ...o, preserveLocation }))
  }, [])
  const setExportCreator = useCallback((creator: string) => {
    setExportOptions(o => ({ ...o, creator }))
  }, [])
  const setExportCopyright = useCallback((copyright: string) => {
    setExportOptions(o => ({ ...o, copyright }))
  }, [])
  const setExportColorSpace = useCallback((colorSpace: ExportColorSpace) => {
    setExportOptions(o => ({ ...o, colorSpace }))
  }, [])
  const setExportFilename = useCallback((name: string) => {
    const file = originalFile.current
    setExportFilenameFor(file ? { file, name } : null)
  }, [originalFile])
  const resetExportFilename = useCallback(() => setExportFilenameFor(null), [])
  /** 把当前这套导出设置存成这台设备的默认值；当前照片不受影响。 */
  const saveExportDefaults = useCallback(() => {
    persistExportDefaults(exportOptions)
    if (saveAccountPreferences) {
      void saveAccountPreferences({ export: exportOptions }).then(
        () => noticeOk('以后下载和分享默认用这套导出设置，已同步到账号。'),
        () => noticeOk('已保存到这台设备；账号同步没成功，下次联网再试。'),
      )
    } else {
      noticeOk('以后下载和分享默认用这套导出设置。')
    }
  }, [exportOptions, noticeOk, saveAccountPreferences])

  /** 非 null = 正在问"上次那张要替换掉吗"，手里攥着刚做好的那张图。
   *
   *  ⚠️ **配方是"问的那一刻"那一份，不是回答那一刻的**（终审 M4）。`blob` 是
   *  按下「保存」时导出的，而 `params` / `messages` 若等到他回答时现读，中间他
   *  回头又改了一版（或又生成了一张）就会**张冠李戴**：存进去的图是旧那张、
   *  配方却是新那套 —— 详情页会把一套这张图上根本没发生过的调整当教学讲给他
   *  （§3.5.1 说这一页的全部价值就在"配方是真的"）。窗口很窄，但后果正好落在
   *  那个价值上。 */
  const [asking, setAsking] =
    useState<{ blob: Blob; name: string; recipe: Recipe } | null>(null)

  /** 存失败时把图和名字留在这儿 —— **它是那个「下载」按钮的全部依据**（§6.6 ①）。
   *  ⚠️ `blob` 为 null 是**另一种失败**：图根本没做出来（`buildExportBlob` 那步就炸了）。
   *  那时候没有东西能给用户，说的话也不能是"图还在" —— 那是骗人（他会去找一个
   *  屏幕上根本不存在的按钮）。 */
  const [saveFail, setSaveFail] =
    useState<{ blob: Blob | null; name: string; why: string } | null>(null)

  const renderExport = useCallback(async (options: ExportOptions, withWatermark = true) => {
    const canvas = canvasEl.current
    const file = originalFile.current
    if (!canvas || !file) return null
    await preloadStickerImages(layers)
    // 尺寸只在用户真的选小的时候缩一次；选「原图」时用屏幕上那块画布，
    // 一个像素都不重绘（和加导出设置之前逐字节同一条路）。
    let source: HTMLCanvasElement = canvas
    const aspect = options.aspect ?? 'original'
    if (aspect !== 'original') {
      if ((options.fit ?? 'crop') === 'crop') {
        const crop = cropRectForAspect(canvas.width, canvas.height, aspect)
        if (crop.x !== 0 || crop.y !== 0 || crop.w !== canvas.width || crop.h !== canvas.height) {
          const cut = makeCanvas(crop.w, crop.h, '裁不出这个导出比例')
          cut.ctx.drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
          // 文字层按原图坐标画，再平移到裁切后的画布；裁切框外的字自然被裁掉。
          drawEditLayers(cut.ctx, layers, canvas.width, canvas.height, -crop.x, -crop.y)
          source = cut.canvas
        } else if (layers.length > 0) {
          const copy = makeCanvas(canvas.width, canvas.height, '叠不上文字层')
          copy.ctx.drawImage(canvas, 0, 0)
          drawEditLayers(copy.ctx, layers, canvas.width, canvas.height)
          source = copy.canvas
        }
      } else {
        source = expandCanvas(canvas, aspect, options.fit ?? 'blur')
        const size = expandedSize(canvas.width, canvas.height, aspect)
        const dx = Math.round((size.width - canvas.width) / 2)
        const dy = Math.round((size.height - canvas.height) / 2)
        const ctx = source.getContext('2d')
        if (ctx) drawEditLayers(ctx, layers, canvas.width, canvas.height, dx, dy)
      }
    } else if (layers.length > 0) {
      const copy = makeCanvas(canvas.width, canvas.height, '叠不上文字层')
      copy.ctx.drawImage(canvas, 0, 0)
      drawEditLayers(copy.ctx, layers, canvas.width, canvas.height)
      source = copy.canvas
    }
    const size = exportSize(
      source.width, source.height, options.longEdge,
      aspect !== 'original',
    )
    let target = canvas
    if (source !== canvas) target = source
    if (size.width !== source.width || size.height !== source.height) {
      const made = makeCanvas(size.width, size.height, '缩不出这张导出图')
      made.ctx.drawImage(source, 0, 0, size.width, size.height)
      target = made.canvas
    }
    const output = withWatermark
      ? markExportCanvas(target, exportWatermark, exportLogo)
      : target
    return {
      blob: await buildExportBlob(
        output, file, options.format, options.qualityPct / 100,
        options.preserveMetadata !== false,
        options.colorSpace ?? 'srgb',
        options.preserveLocation !== false,
        { creator: options.creator, copyright: options.copyright },
      ),
      name: buildFilename(
        file.name,
        options.format,
        exportFilenameFor?.file === file ? exportFilenameFor.name : '',
      ),
    }
  }, [canvasEl, originalFile, layers, exportWatermark, exportLogo, exportFilenameFor])

  const exportCurrent = useCallback(
    () => renderExport(exportOptions),
    [renderExport, exportOptions],
  )

  // 分享：画布尺寸就是当前 base 的尺寸。调色不缩图（spec §4.4）。
  //
  // 用户在真机上跑完 30 秒那条线后的原话：「下载后用户第一时间是不知道在哪里的」
  // —— 时间够了，但那一段让人心里没底。所以能分享的设备多给一个「分享」：
  // 点一下弹系统面板、一步选微信，跳过"翻文件管理器找图"。
  //
  // ⚠️ **这条路现在只做分享**（2026-09-25 / Task 13）。它以前还兼着
  // 「保存 = 老老实实下载」那一半，而 §3.4 把那一半搬走了：保存现在走 `onSave`
  // 存进作品集，不再偷偷下载。原来那个 `wantShare` 参数和它的早退分支
  // （`if (!wantShare || !canShare) downloadImage(...)`）**已经删掉** ——
  // 留着会让下一个读代码的人以为保存还会下载。
  // 下面 catch 里的"退回下载"**留着**：用户点的是"把图给我"，分享只是其中一种
  // 给法，失败不该让他两手空空（用户明确说过有时候就是不想分享）。
  const onShare = useCallback(async () => {
    if (!canvasEl.current || !originalFile.current) return
    setDelivering('share')
    try {
      const out = await exportCurrent()
      if (!out) return
      try {
        await shareImage(out.blob, out.name)
      } catch (e) {
        // 分享真的失败了（没权限、系统拒绝）。退回下载，至少让他拿得到图。
        // 用户自己取消**不会**走到这儿 —— shareImage 把取消当成正常结束。
        console.error(e)
        downloadImage(out.blob, out.name)
      }
    } catch (e) {
      // 走到这儿只剩一种可能：`buildExportBlob` 自己失败了（图都没做出来），
      // 那时候也没有能退回下载的东西。
      console.error(e)
      noticeBad('分享失败，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [exportCurrent, canvasEl, originalFile, noticeBad])

  // ── 「下载」= 桌面上把图拿到手的唯一一条路（2026-09-30 补）────────────
  //
  // ⚠️ **这个按钮存在的全部理由**：2026-09-29 的产品测试量出来，桌面上
  //    **没有任何一条路能把图拿到手** ——
  //      · 顶栏只有「调色 / 分享 / 保存」；
  //      · 「分享」只在 `canShare` 为真时渲染，而桌面 Chrome 的
  //        `navigator.share` 不认图片 → **那个按钮根本不出现**；
  //      · 「保存」只存进作品集；唯一的「下载到电脑」藏在**保存失败的横幅**里，
  //        也就是说，图**存成功了反而拿不到**。
  //    手机上那条路是通的（系统分享面板），所以这纯粹是桌面的缺口。
  //    修法就是把「分享」那一格在不能分享的设备上换成「下载」——
  //    **同一格位置，同一件事（把图给我）的两种给法**，不是多出一个按钮。
  //    （原来那格空着，理由是"不留一个点了没用的按钮"—— 那个理由对
  //    "点了没反应"成立，对"这是唯一一条拿图的路"不成立。）
  const onDownload = useCallback(async () => {
    if (!canvasEl.current || !originalFile.current) return
    setDelivering('download')
    try {
      const out = await exportCurrent()
      if (out) downloadImage(out.blob, out.name)
    } catch (e) {
      // 走到这儿只剩一种可能：`buildExportBlob` 自己失败了（图都没做出来）。
      // 和分享那条**说同一句话** —— 用户看到的都是"把图给我"这一件事没成，
      // 分成两种说法只会让他以为出了两种毛病。
      console.error(e)
      noticeBad('图没能导出来，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [exportCurrent, canvasEl, originalFile, noticeBad])

  const onExportPlatforms = useCallback(async () => {
    const file = originalFile.current
    if (!canvasEl.current || !file) return
    setDelivering('platforms')
    try {
      const result = await buildSocialExportZip(
        file,
        exportOptions,
        async options => {
          const out = await renderExport(options)
          if (!out) throw new Error('画布还没准备好')
          return out.blob
        },
        exportFilenameFor?.file === file ? exportFilenameFor.name : '',
      )
      downloadImage(result.blob, result.name)
      noticeOk(`已打包 ${result.count} 个社交尺寸。`)
    } catch (e) {
      console.error(e)
      noticeBad('社交尺寸没打包成，再试一次')
    } finally {
      setDelivering(null)
    }
  }, [canvasEl, originalFile, exportOptions, exportFilenameFor, noticeBad, noticeOk, renderExport])

  /**
   * 只导出“当前 JPG 成片 + 原始动作短片”的兼容包。静帧强制 JPG 并保留拍摄
   * 信息，避免用户刚好选了 PNG / “移除拍摄信息”时把实况标识一起扔掉；MOV
   * 不转码。只有导入时核对为 verified 的一对才允许走这里。
   */
  const onExportLivePhoto = useCallback(async (mode: 'download' | 'share' = 'download') => {
    if (!canvasEl.current || !originalFile.current || !livePhotoPair) return
    if (livePhotoEvidence?.status !== 'verified') {
      noticeBad('照片和动作的 Apple 实况标识还没有核对一致，不能打成一包。')
      return
    }
    setDelivering('live')
    try {
      const out = await renderExport({
        ...exportOptions,
        format: 'image/jpeg',
        qualityPct: 95,
        longEdge: null,
        aspect: 'original',
        fit: 'crop',
        preserveMetadata: true,
      })
      if (!out) return
      const bundle = await buildLivePhotoBundle(out.blob, out.name, livePhotoPair.movie)
      if (mode === 'share') {
        try {
          const result = await shareFile(bundle.blob, bundle.name)
          if (result === 'shared') {
            noticeOk(
              '实况照片兼容包已分享。ZIP 解压后是同一 stem 的 JPG 和 MOV；' +
              '它不是 Apple 原生 Live Photo 容器。',
            )
          }
        } catch (e) {
          console.error('实况照片兼容包分享失败，改为下载', e)
          downloadImage(bundle.blob, bundle.name)
          noticeBad('系统分享没成功，已改为下载实况照片兼容包 ZIP。')
        }
      } else {
        downloadImage(bundle.blob, bundle.name)
        noticeOk(
          '实况照片兼容包已下载：解压后把 JPG 和 MOV 放在同一处。' +
          '它不是 Apple 原生 Live Photo 容器，导入「照片」后仍可能显示为两个文件。',
        )
      }
    } catch (e) {
      console.error('实况照片兼容包没做出来', e)
      noticeBad('实况照片兼容包没做出来，再试一次；静帧会使用 JPG 和当前成片。')
    } finally {
      setDelivering(null)
    }
  }, [
    canvasEl, exportOptions, livePhotoEvidence, livePhotoPair,
    noticeBad, noticeOk, originalFile, renderExport,
  ])

  const onCopy = useCallback(async () => {
    if (!canvasEl.current || !originalFile.current) return
    setDelivering('copy')
    try {
      const out = await exportCurrent()
      if (!out) return
      await copyImage(out.blob)
      noticeOk('图已经复制，可以直接粘贴了。')
    } catch (e) {
      console.error('复制图片失败', e)
      noticeBad('这台浏览器没能复制图片，先用下载或分享吧。')
    } finally {
      setDelivering(null)
    }
  }, [exportCurrent, canvasEl, originalFile, noticeBad, noticeOk])

  // ── 「保存」= 存进作品集（Task 13，§3.4）──────────────────────────────
  // ⚠️ 这条路**一个字节都不下载**。下载挪到作品集里，由用户自己决定要哪张、
  //    存到哪 —— 设一个"默认开"的开关很别扭，因为**用户一开始根本不知道有
  //    那么个开关**；顺带也不再偷偷往他的下载文件夹堆东西。
  //
  //    代价是：**存不进去的时候，改好的图就只在屏幕上，一关页面就没了**。
  //    而那一刻他要的是"拿到图去发朋友圈"。所以下面那条失败路径上必须当场
  //    给一个「下载」—— §6.6 ①，§10 点名它「最容易漏」。

  /**
   * **此刻**这一份配方：参数 + 用户在屏幕上说过的原话 + （★ 2026-10-05）用的滤镜。
   *
   * ★ 抽成一个函数只有一个理由：口径**只有一份**。`saveOnce` 平时现读它，
   * 而「上次那张要替换掉吗」那条路要在**问的那一刻**把它拍下来（终审 M4）——
   * 两处各写一遍的话，哪天口径变一处就会漏一处。
   *
   * ★ 原话 = 用户在屏幕上说过的那些话（裁定 ④）。
   *   `role: 'user'` 有**两个**来源，两个都该在这里：`send`（他敲进去的那句）
   *   和 `onCard`（**点建议卡片** —— 他点了「亮一点」，那就是他说了「亮一点」，
   *   把卡片标签记成用户消息是**对的**，不是 bug）。
   *   **不记 `editPrompt`** —— 那是给图片模型的英文 prompt，是我们的实现细节。
   */
  const recipeNow = useCallback((): Recipe => {
    // ★ 2026-10-05（T12）：滤镜只存**名字**（id 对已经烤好的图没有意义，见
    //   `shared/works.ts`）。名字从清单里**现查** —— 查不到（刚被删）就记 null：
    //   记一个显示不出来的 id，详情页那一行和「套到别的图上」都认不出来，
    //   而屏幕上看起来一切正常（这一类静默失败正是这一轮反复在防的）。
    const hit = lut ? luts.find((l) => l.id === lut.lutId) : undefined
    return {
      params,
      edits: messages.filter(m => m.role === 'user').map(m => m.text),
      lut: lut && hit ? { name: hit.name, amount: lut.amount } : null,
    }
  }, [params, messages, lut, luts])

  /**
   * 存一次。`replaceId` 非 null = 替换掉那一张，null = 新存一张。
   *
   * ⚠️ **故意不收 `name`。** 文件名只对"下载到电脑"和失败时那句话有意义，
   *    存这一路用不上它 —— 服务端那份 `WorkInput` 只有 image / thumb / recipe，
   *    名字是详情页「改名」那条路管的（`renameWork`）。计划里那一版签名带着
   *    `name` 而从头到尾没读过它，`noUnusedParameters` 会当场红。
   *
   * ⚠️ `recipeAt` 传了就用它，没传才现读 `recipeNow()`（终审 M4）：
   *    「上次那张要替换掉吗」那条路隔着用户的一次回答，横幅挂着的时候他可能回头
   *    又改了一版。现读的话，存进去的是**旧图 + 新配方** —— 详情页会把这套调整
   *    当教学讲给他，而这套调整在这张图上从没发生过。
   */
  const saveOnce = useCallback(async (blob: Blob, replaceId: number | null, recipeAt?: Recipe) => {
    const canvas = canvasEl.current
    // 缩略图是**顺手带的**：生成失败不该让整张图存不进去（裁定 ②）
    // ⚠️ 这一张要**显式传** `GALLERY_THUMB_MAX_SIDE`（480），不能用默认的 160：
    //    它下面是作品页那个**正方形**的格子（`aspect-ratio: 1/1; object-fit: cover`），
    //    吃的是缩略图的**短边**，而 `maxSide` 限制的是长边 —— 竖图 120×160 在
    //    181px 的格子里会被拉 1.51×（DPR 2 的屏上 3.02×）。算式在那个常量的注释里。
    //    （对话/撤销历史里那张仍旧用默认的 160，那一档是对的，别一起改。）
    let thumb: string | undefined
    try {
      if (canvas) thumb = makeThumbnail(canvas, GALLERY_THUMB_MAX_SIDE)
    } catch (e) {
      console.error('缩略图没做出来，这张作品将没有缩略图：', e)
    }
    const recipe = recipeAt ?? recipeNow()
    const currentFile = originalFile.current
    const sourceMeta = replaceId === null && currentFile
      ? Promise.resolve(readLensInfo(currentFile)).catch(() => null)
      : Promise.resolve(null)
    const lens = await sourceMeta
    const body = {
      image: await blobToDataUrl(blob),
      thumb,
      recipe,
      ...(replaceId === null && currentFile ? { sourceName: currentFile.name } : {}),
      ...(replaceId === null && lens?.takenAtMs
        ? { capturedAt: lens.takenAtMs }
        : {}),
      ...(replaceId === null && lens?.make ? { cameraMake: lens.make } : {}),
      ...(replaceId === null && lens?.model ? { cameraModel: lens.model } : {}),
      ...(replaceId === null && lens?.lens ? { lensModel: lens.lens } : {}),
    }
    if (replaceId !== null) {
      await replaceWork(replaceId, body)
    } else {
      const { id } = await createWork(body)
      setSavedId(id)
    }
    // 说一句"存好了"。**走通报条，不走对话**（2026-09-30 改）——
    // 理由不是"它不是对话"，是**对话栏有时候根本不在屏上**：手机上打开调色
    // 面板时 `.chat` 是 `display: none`（面板和对话在抢竖向空间），而那一刻
    // 正是用户拖完滑块按「保存」的时候。这句话原来落进一个用户看不见的地方，
    // 全链路回归在手机那趟抓到的（桌面全绿）。
    //
    // ⚠️ 也**绝不能**改成 `setMessages` 手写一条 `role: 'user'` ——
    // 那会当场变成"用户说过的原话"，混进上面那份配方里。
    noticeOk('存好了，在左边「作品」里。')
  }, [recipeNow, canvasEl, originalFile, setSavedId, noticeOk])

  const onSave = useCallback(async () => {
    if (!canvasEl.current || !originalFile.current) return
    setDelivering('save')
    setSaveFail(null)
    // ⚠️ 声明在 try 外面、留着 null：它同时是"图做出来了没有"的标记，
    //    catch 里要靠它决定能不能给用户一个「下载」（§6.6 ①）。
    let out: { blob: Blob; name: string } | null = null
    try {
      // 存进作品集是**我们自己保存的母版**：固定 JPEG 95% 原尺寸。
      // 导出设置只决定用户下载 / 分享拿到什么格式，不改变作品集里的存储格式
      // （服务端也只收 JPEG / PNG data URL）。
      out = await renderExport(DEFAULT_EXPORT_OPTIONS, false)
      if (!out) return
      if (savedId !== null) {
        // 同一张照片改过好几遍了 —— 问一句。不问的话改了 5 遍就是 5 张
        // 几乎一样的图，作品集立刻没法看（§3.4）。
        // ⚠️ **顺手把配方一起拍下来**（终审 M4）：他回答之前可能又改了一版，
        //    那时候现读的就是"新那套配旧那张图"。
        setAsking({ blob: out.blob, name: out.name, recipe: recipeNow() })
        return
      }
      await saveOnce(out.blob, null)
    } catch (e) {
      console.error(e)
      // ★★ §6.6 ①：那一刻他的目的是"拿到图去发朋友圈"。存不进去是**我们这边的
      //    限制**，不该让他连图都拿不到。所以把 blob 留下来，界面上出现一个
      //    能下载的按钮。`blob` 还是 null 就是**另一种失败**（图都没做出来），
      //    那种情况下没有东西可以给，说的话也不一样 —— 见下面那段。
      //    （`out` 为 null 时那个 `name` 永远不会被读到：没图就没有下载按钮。）
      setSaveFail({
        blob: out?.blob ?? null, name: out?.name ?? '',
        why: errorText(e, '没存进去'),
      })
    } finally {
      setDelivering(null)
    }
  }, [savedId, saveOnce, recipeNow, renderExport, canvasEl, originalFile])

  /** 回答「上次那张要替换掉吗」：`replaceId` 非 null = 替换，null = 再存一张。
   *  两条回答走**同一段代码**，只有那一个参数不同 —— 分开写两份的话，
   *  「存失败怎么办」那一半迟早只在其中一份里改。
   *
   *  ⚠️ 配方用的是 `asking` 里**拍下来的那一份**（终审 M4），不是现读：
   *  问的是"上次那张要替换掉吗"，那就得配着那张图当时的调整一起存。 */
  const answerAsk = useCallback((replaceId: number | null) => {
    const cur = asking
    if (!cur) return
    setAsking(null)
    setDelivering('save')
    void saveOnce(cur.blob, replaceId, cur.recipe)
      .catch((e) => setSaveFail({
        blob: cur.blob, name: cur.name,
        why: errorText(e, '没存进去'),
      }))
      .finally(() => setDelivering(null))
  }, [asking, saveOnce])

  /** 收掉那句「上次那张要替换掉吗」。换照片、切会话、重置时必须调 ——
   *  不然那条问句问的还是**上一张照片**存过什么（见 `App.tsx` 里两处调用点）。 */
  const dismissAsk = useCallback(() => setAsking(null), [])

  return {
    delivering, asking, saveFail,
    onExportPlatforms,
    onExportLivePhoto,
    onShare, onDownload, onSave, onCopy, copySupported, canShareArchive, answerAsk,
    heicSupported,
    dismissAsk, setSaveFail,
    exportOptions, setExportFormat, setExportQuality, setExportLongEdge,
    setExportAspect, setExportFit, setExportMetadata, setExportLocation, setExportColorSpace,
    setExportCreator, setExportCopyright,
    saveExportDefaults,
    exportFilename: exportFilenameFor?.name ?? '',
    setExportFilename, resetExportFilename,
    exportWatermark, setExportWatermark: updateExportWatermark, exportLogo, pickExportLogo,
  }
}
