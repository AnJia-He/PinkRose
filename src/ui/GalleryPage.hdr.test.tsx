// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GalleryPage } from './GalleryPage.tsx'

const { initialFiles } = vi.hoisted(() => ({ initialFiles: [] as string[] }))

vi.mock('../api/works', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/works')>()
  return {
    ...actual,
    listWorks: vi.fn(async () => []),
  }
})

vi.mock('./HdrPanel', () => ({
  default: ({ onBack, initialFiles: files }: {
    onBack: () => void
    initialFiles?: File[]
  }) => {
    initialFiles.splice(0, initialFiles.length, ...(files ?? []).map(file => file.name))
    return (
      <section className="hdr-page">
        <button className="batch-back" onClick={onBack}>返回作品页</button>
      </section>
    )
  },
}))

describe('相机包围曝光直达 HDR', () => {
  beforeEach(() => {
    initialFiles.length = 0
  })

  it('作品页收到整组照片后自动打开 HDR，并清掉一次性种子', async () => {
    const onHdrSeedUsed = vi.fn()
    const files = [
      new File(['dark'], 'shot-1.jpg', { type: 'image/jpeg' }),
      new File(['normal'], 'shot-2.jpg', { type: 'image/jpeg' }),
      new File(['bright'], 'shot-3.jpg', { type: 'image/jpeg' }),
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <GalleryPage
          onOpen={() => {}}
          onNew={() => {}}
          hdrSeed={files}
          onHdrSeedUsed={onHdrSeedUsed}
        />,
      )
    })

    await vi.waitFor(() => expect(container.querySelector('.hdr-page')).toBeTruthy())
    expect(initialFiles).toEqual(['shot-1.jpg', 'shot-2.jpg', 'shot-3.jpg'])
    expect(onHdrSeedUsed).toHaveBeenCalledTimes(1)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.hdr-page')).toBeNull()
    expect(container.querySelector('.gallery')).toBeTruthy()

    await act(async () => { root.unmount() })
    container.remove()
  })
})
