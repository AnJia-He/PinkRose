// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExportSettings from './ExportSettings'
import { DEFAULT_EXPORT_OPTIONS } from '../export/save'
import { DEFAULT_WATERMARK } from '../image/watermark'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('导出设置', () => {
  it('格式 / 质量 / 长边都交给上层', async () => {
    const onFormat = vi.fn()
    const onQuality = vi.fn()
    const onLongEdge = vi.fn()
    const onAspect = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={onFormat}
          onQuality={onQuality}
          onLongEdge={onLongEdge}
          onAspect={onAspect}
        />,
      )
    })

    const png = container.querySelector('input[name="export-format"][value="image/png"]') as HTMLInputElement
    const webp = container.querySelector('input[name="export-format"][value="image/webp"]') as HTMLInputElement
    const tiff = container.querySelector('input[name="export-format"][value="image/tiff"]') as HTMLInputElement
    expect(png).toBeTruthy()
    expect(webp).toBeTruthy()
    expect(tiff).toBeTruthy()
    await act(async () => { png.click() })
    await act(async () => { webp.click() })
    await act(async () => { tiff.click() })
    expect(onFormat.mock.calls.map(c => c[0]))
      .toEqual(['image/png', 'image/webp', 'image/tiff'])

    const quality = container.querySelector('input[name="export-quality"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(quality, '80')
      quality.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onQuality).toHaveBeenCalledWith(80)

    const size = container.querySelector('input[name="export-size"][value="1080"]') as HTMLInputElement
    await act(async () => { size.click() })
    expect(onLongEdge).toHaveBeenCalledWith(1080)

    const square = container.querySelector('input[name="export-aspect"][value="1:1"]') as HTMLInputElement
    await act(async () => { square.click() })
    expect(onAspect).toHaveBeenCalledWith('1:1')
  })

  it('HEIC 只在服务端确认有编码器时出现', async () => {
    const onFormat = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={onFormat}
          onQuality={() => {}}
          onLongEdge={() => {}}
        />,
      )
    })
    expect(container.querySelector('input[name="export-format"][value="image/heic"]')).toBeNull()

    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={onFormat}
          onQuality={() => {}}
          onLongEdge={() => {}}
          heicSupported
        />,
      )
    })
    const heic = container.querySelector(
      'input[name="export-format"][value="image/heic"]') as HTMLInputElement
    expect(heic).toBeTruthy()
    await act(async () => { heic.click() })
    expect(onFormat).toHaveBeenCalledWith('image/heic')
  })

  it('实况照片只有 ID 一致时才允许导出照片 + 动作兼容包', async () => {
    const onExportLivePhoto = vi.fn(async () => {})
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          livePhoto={{ status: 'checking', detail: '正在核对 Apple 实况标识…' }}
          onExportLivePhoto={onExportLivePhoto}
        />,
      )
    })
    const liveExport = () => [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '导出照片 + 动作 ZIP') as HTMLButtonElement
    expect(liveExport()?.disabled).toBe(true)
    expect(container.textContent).toContain('不冒充 Apple 原生 Live Photo')

    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          livePhoto={{ status: 'verified', detail: '照片和 MOV 的 Apple 实况标识一致。' }}
          onExportLivePhoto={onExportLivePhoto}
        />,
      )
    })
    expect(liveExport().disabled).toBe(false)
    expect([...container.querySelectorAll('button')]
      .some(button => button.textContent?.trim() === '分享兼容包')).toBe(false)
    await act(async () => {
      liveExport().click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onExportLivePhoto).toHaveBeenLastCalledWith('download')

    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          livePhoto={{ status: 'verified', detail: '照片和 MOV 的 Apple 实况标识一致。' }}
          onExportLivePhoto={onExportLivePhoto}
          canShareArchive
        />,
      )
    })
    const share = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '分享兼容包') as HTMLButtonElement
    expect(share).toBeTruthy()
    await act(async () => {
      share.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(onExportLivePhoto).toHaveBeenLastCalledWith('share')
  })

  it('PNG 不显示质量（无损）', async () => {
    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/png' }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onAspect={() => {}}
        />,
      )
    })
    expect(container.querySelector('input[name="export-quality"]')).toBeNull()
    expect(container.textContent).toContain('PNG 无损')
  })

  it('会内嵌 ICC 的格式明确显示 sRGB 色彩配置', async () => {
    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/png' }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
        />,
      )
    })
    expect(container.textContent).toContain('内嵌 sRGB ICC 色彩配置')

    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/avif' }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
        />,
      )
    })
    expect(container.textContent).not.toContain('内嵌 sRGB ICC 色彩配置')
  })

  it('支持选择 Display P3，并明确编辑色域仍是 sRGB', async () => {
    const onColorSpace = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/png' }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onColorSpace={onColorSpace}
        />,
      )
    })
    const p3 = container.querySelector(
      'input[name="export-color-space"][value="display-p3"]',
    ) as HTMLInputElement
    expect(p3).toBeTruthy()
    await act(async () => { p3.click() })
    expect(onColorSpace).toHaveBeenCalledWith('display-p3')

    await act(async () => {
      root.render(
        <ExportSettings
          options={{
            ...DEFAULT_EXPORT_OPTIONS,
            format: 'image/png',
            colorSpace: 'display-p3',
          }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onColorSpace={onColorSpace}
        />,
      )
    })
    expect(container.textContent).toContain('内嵌 Display P3 ICC')
    expect(container.textContent).toContain('不会恢复超出 sRGB')
  })

  it('自定义文件名交给上层；留空提示默认命名', async () => {
    const onFilename = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          filename="海边的日落"
          onFilename={onFilename}
        />,
      )
    })
    const input = container.querySelector('input[name="export-filename"]') as HTMLInputElement
    expect(input.value).toBe('海边的日落')
    expect(input.placeholder).toContain('原文件名_pinkrose')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '新的名字')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onFilename).toHaveBeenCalledWith('新的名字')
  })

  it('常用平台：一键套 JPG / 长边 1080 / 平台比例 / 居中裁切', async () => {
    const onFormat = vi.fn()
    const onQuality = vi.fn()
    const onLongEdge = vi.fn()
    const onAspect = vi.fn()
    const onFit = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={onFormat}
          onQuality={onQuality}
          onLongEdge={onLongEdge}
          onAspect={onAspect}
          onFit={onFit}
        />,
      )
    })

    const xhs = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '小红书')!
    expect(xhs).toBeTruthy()
    await act(async () => { xhs.click() })

    expect(onFormat).toHaveBeenCalledWith('image/jpeg')
    expect(onQuality).toHaveBeenCalledWith(92)
    expect(onLongEdge).toHaveBeenCalledWith(1080)
    expect(onAspect).toHaveBeenCalledWith('3:4')
    expect(onFit).toHaveBeenCalledWith('crop')
  })

  it('「全部打包」交给上层，并在等待时锁住按钮', async () => {
    let finish!: () => void
    const onExportPlatforms = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onAspect={() => {}}
          onExportPlatforms={onExportPlatforms}
        />,
      )
    })
    const pack = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '全部打包') as HTMLButtonElement
    expect(pack).toBeTruthy()
    await act(async () => {
      pack.click()
      await Promise.resolve()
    })
    expect(onExportPlatforms).toHaveBeenCalledTimes(1)
    expect(pack.disabled).toBe(true)
    expect(pack.textContent).toBe('正在打包…')
    await act(async () => { finish(); await Promise.resolve() })
    expect(pack.disabled).toBe(false)
  })

  it('手机端面板可以收起（面板固定后会盖住摘要）', async () => {
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onAspect={() => {}}
        />,
      )
    })
    const details = container.querySelector('details')!
    details.open = true
    const close = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '收起')!
    expect(close).toBeTruthy()
    await act(async () => { close.click() })
    expect(details.open).toBe(false)
  })

  it('选了社交比例后能选裁切 / 模糊扩展 / 镜像扩展', async () => {
    const onFit = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, aspect: '1:1' }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onAspect={() => {}}
          onFit={onFit}
        />,
      )
    })
    const blur = container.querySelector('input[name="export-fit"][value="blur"]') as HTMLInputElement
    expect(blur).toBeTruthy()
    await act(async () => { blur.click() })
    expect(onFit).toHaveBeenCalledWith('blur')
  })

  it('默认保留拍摄信息，关掉后把 false 交给上层', async () => {
    const onMetadata = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onMetadata={onMetadata}
        />,
      )
    })
    const keep = container.querySelector('input[name="export-metadata"]') as HTMLInputElement
    expect(keep).toBeTruthy()
    expect(keep.checked).toBe(true)
    await act(async () => { keep.click() })
    expect(onMetadata).toHaveBeenCalledWith(false)
  })

  it('可以只移除 GPS，保留相机和曝光信息', async () => {
    const onLocation = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onMetadata={() => {}}
          onLocation={onLocation}
        />,
      )
    })
    const location = container.querySelector(
      'input[name="export-location"]') as HTMLInputElement
    expect(location).toBeTruthy()
    expect(location.checked).toBe(true)
    await act(async () => { location.click() })
    expect(onLocation).toHaveBeenCalledWith(false)

    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, preserveMetadata: false }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onMetadata={() => {}}
          onLocation={onLocation}
        />,
      )
    })
    expect(container.querySelector('input[name="export-location"]')).toBeNull()
  })

  it('可以设置作者与版权；关闭拍摄信息后不再显示这两个字段', async () => {
    const onCreator = vi.fn()
    const onCopyright = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onMetadata={() => {}}
          onCreator={onCreator}
          onCopyright={onCopyright}
        />,
      )
    })
    const creator = container.querySelector('input[name="export-creator"]') as HTMLInputElement
    const copyright = container.querySelector('input[name="export-copyright"]') as HTMLInputElement
    expect(creator).toBeTruthy()
    expect(copyright).toBeTruthy()
    expect(creator.placeholder).toContain('保留原照片作者')
    expect(copyright.placeholder).toContain('保留原照片版权')
    expect(container.textContent).toContain('建议使用英文、数字、拼音和 ©')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(creator, 'Photographer A')
      creator.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(copyright, '© 2026 Photographer A')
      copyright.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onCreator).toHaveBeenCalledWith('Photographer A')
    expect(onCopyright).toHaveBeenCalledWith('© 2026 Photographer A')

    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, preserveMetadata: false }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onMetadata={() => {}}
          onCreator={onCreator}
          onCopyright={onCopyright}
        />,
      )
    })
    expect(container.querySelector('input[name="export-creator"]')).toBeNull()
  })

  it('PNG / WebP / TIFF 也能保留拍摄信息', async () => {
    for (const format of ['image/png', 'image/webp', 'image/tiff'] as const) {
      await act(async () => {
        root.render(
          <ExportSettings
            options={{ ...DEFAULT_EXPORT_OPTIONS, format }}
            onFormat={() => {}}
            onQuality={() => {}}
            onLongEdge={() => {}}
            onMetadata={() => {}}
          />,
        )
      })
      expect(container.querySelector('input[name="export-metadata"]')).toBeTruthy()
      expect(container.textContent).not.toContain('当前格式不写入拍摄信息')
    }
  })

  it('AVIF / HEIC 明确说明当前不写入拍摄信息', async () => {
    for (const format of ['image/avif', 'image/heic'] as const) {
      await act(async () => {
        root.render(
          <ExportSettings
            options={{ ...DEFAULT_EXPORT_OPTIONS, format }}
            onFormat={() => {}}
            onQuality={() => {}}
            onLongEdge={() => {}}
            onMetadata={() => {}}
            heicSupported
          />,
        )
      })
      expect(container.querySelector('input[name="export-metadata"]')).toBeNull()
      expect(container.textContent).toContain('当前格式不写入拍摄信息')
      expect(container.textContent).toContain('JPG、PNG 或 WebP')
    }
  })

  it('支持图片剪贴板时显示「复制图片」并交给上层', async () => {
    const onCopy = vi.fn(async () => {})
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          copySupported
          onCopy={onCopy}
        />,
      )
    })
    const copy = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '复制图片')!
    expect(copy).toBeTruthy()
    await act(async () => { copy.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(onCopy).toHaveBeenCalledTimes(1)
  })

  it('「设为默认」把当前这套设置交给上层', async () => {
    const onSaveDefaults = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/webp', qualityPct: 82 }}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          onSaveDefaults={onSaveDefaults}
        />,
      )
    })
    const save = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '设为默认')!
    expect(save).toBeTruthy()
    await act(async () => { save.click() })
    expect(onSaveDefaults).toHaveBeenCalledTimes(1)
  })

  it('导出设置里能切平铺水印，并把整份选项交给上层', async () => {
    const onWatermark = vi.fn()
    await act(async () => {
      root.render(
        <ExportSettings
          options={DEFAULT_EXPORT_OPTIONS}
          onFormat={() => {}}
          onQuality={() => {}}
          onLongEdge={() => {}}
          watermark={{ ...DEFAULT_WATERMARK, text: 'PinkRose' }}
          onWatermark={onWatermark}
        />,
      )
    })
    const tile = container.querySelector(
      'input[name="export-watermark-tile"][value="tile"]') as HTMLInputElement
    expect(tile).toBeTruthy()
    await act(async () => { tile.click() })
    expect(onWatermark).toHaveBeenCalledWith(expect.objectContaining({
      text: 'PinkRose', tile: true,
    }))
  })
})
