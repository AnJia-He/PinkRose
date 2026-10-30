// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GalleryPage } from './GalleryPage.tsx'

const seeded = vi.hoisted(() => ({ names: [] as string[] }))

vi.mock('../api/works', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/works')>()
  return { ...actual, listWorks: vi.fn(async () => []) }
})

vi.mock('./FocusStackPanel', () => ({
  default: ({ onBack, initialFiles }: {
    onBack: () => void
    initialFiles?: File[]
  }) => {
    seeded.names.splice(0, seeded.names.length, ...(initialFiles ?? []).map(file => file.name))
    return (
      <section className="focus-page">
        <button className="batch-back" onClick={onBack}>返回作品页</button>
      </section>
    )
  },
}))

describe('相机焦点包围直达焦点堆栈', () => {
  beforeEach(() => { seeded.names.length = 0 })

  it('作品页收到整组照片后自动打开焦点堆栈，并清掉一次性种子', async () => {
    const onFocusSeedUsed = vi.fn()
    const files = ['near.jpg', 'middle.jpg', 'far.jpg'].map((name, index) =>
      new File([String(index)], name, { type: 'image/jpeg' }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <GalleryPage
          onOpen={() => {}}
          onNew={() => {}}
          focusSeed={files}
          onFocusSeedUsed={onFocusSeedUsed}
        />,
      )
    })

    await vi.waitFor(() => expect(container.querySelector('.focus-page')).toBeTruthy())
    expect(seeded.names).toEqual(['near.jpg', 'middle.jpg', 'far.jpg'])
    expect(onFocusSeedUsed).toHaveBeenCalledTimes(1)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.focus-page')).toBeNull()
    expect(container.querySelector('.gallery')).toBeTruthy()

    await act(async () => { root.unmount() })
    container.remove()
  })
})
