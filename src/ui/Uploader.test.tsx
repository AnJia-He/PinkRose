// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Uploader from './Uploader'

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

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (test()) return
  }
  throw new Error(`等不到 ${label}`)
}

describe('上传前拍照入口', () => {
  it('相册多选不会悄悄丢掉后面的照片 —— 整批交给批量处理', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} onPickMany={onPickMany} />) })

    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [a, b], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onPickMany).toHaveBeenCalledWith([a, b], '')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('文件夹导入：只把照片交给批量处理，跳过旁车文件', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} onPickMany={onPickMany} />) })

    const folder = container.querySelector('input[data-folder-picker]') as HTMLInputElement
    expect(folder.multiple).toBe(true)
    expect(folder.getAttribute('webkitdirectory')).not.toBeNull()
    const clickSpy = vi.spyOn(folder, 'click')
    act(() => {
      (container.querySelector('[aria-label="导入文件夹"]') as HTMLButtonElement).click()
    })
    expect(clickSpy).toHaveBeenCalledTimes(1)

    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.png', { type: 'image/png' })
    const raw = new File(['r'], 'shot.cr3', { type: '' })
    const note = new File(['n'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(folder, 'files', {
      value: [a, b, note, raw], configurable: true,
    })
    await act(async () => {
      folder.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onPickMany).toHaveBeenCalledWith([a, b, raw], '')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('普通文件夹里的 RAW + JPG 只保留 RAW，并明确说明已合并', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const jpeg = new File(['jpg'], 'IMG_0001.JPG', { type: 'image/jpeg' })
    const raw = new File(['raw'], 'IMG_0001.CR3', { type: '' })
    Object.defineProperty(jpeg, 'webkitRelativePath', { value: 'trip/IMG_0001.JPG' })
    Object.defineProperty(raw, 'webkitRelativePath', { value: 'trip/IMG_0001.CR3' })
    Object.defineProperty(input, 'files', { value: [jpeg, raw], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onPick).toHaveBeenCalledWith(raw, '')
    expect(container.textContent).toContain('保留 RAW 原始数据')
  })

  it('单张照片旁的同名 XMP 一起交给上层，不把旁车当成第二张照片', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    await act(async () => {
      root.render(<Uploader onPick={onPick} onPickMany={onPickMany} />)
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    expect(input.accept).toContain('.xmp')
    const photo = new File(['jpg'], 'IMG_3001.CR3', { type: '' })
    const sidecar = new File(['<xmp/>'], 'IMG_3001.xmp', { type: 'application/rdf+xml' })
    Object.defineProperty(input, 'files', {
      value: [photo, sidecar], configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onPick).toHaveBeenCalledWith(photo, '', sidecar)
    expect(onPickMany).not.toHaveBeenCalled()
  })

  it('多张照片各自的 XMP 一起交给批量处理，不把旁车混成照片', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    await act(async () => {
      root.render(<Uploader onPick={onPick} onPickMany={onPickMany} />)
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const a = new File(['a'], 'a.CR3', { type: '' })
    const b = new File(['b'], 'b.JPG', { type: 'image/jpeg' })
    const ax = new File(['ax'], 'a.xmp', { type: 'application/rdf+xml' })
    const bx = new File(['bx'], 'b.xmp', { type: 'application/rdf+xml' })
    Object.defineProperty(input, 'files', {
      value: [a, ax, b, bx], configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onPickMany).toHaveBeenCalledWith([a, b], '', [ax, bx])
    expect(onPick).not.toHaveBeenCalled()
  })

  it('拍照按钮调起后置摄像头；拍到的图带着已输入的话一起交给上层', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })

    const wish = container.querySelector('[aria-label="想怎么改"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(wish, '海边一点')
      wish.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const camera = container.querySelector('input[capture="environment"]') as HTMLInputElement
    expect(camera, '拍照入口必须用后置摄像头').toBeTruthy()
    expect(camera.accept).toContain('.heic')
    expect(camera.accept).toContain('.cr3')
    const clickSpy = vi.spyOn(camera, 'click')
    act(() => {
      (container.querySelector('[aria-label="拍照"]') as HTMLButtonElement).click()
    })
    expect(clickSpy).toHaveBeenCalledTimes(1)

    const file = new File(['x'], 'camera.jpg', { type: 'image/jpeg' })
    Object.defineProperty(camera, 'files', { value: [file], configurable: true })
    await act(async () => {
      camera.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onPick).toHaveBeenCalledWith(file, '海边一点')
  })

  it('在页面里粘贴图片 = 直接把这张图交给上层修', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    const file = new File(['x'], 'clipboard.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    })
    await act(async () => { window.dispatchEvent(paste) })
    expect(onPick).toHaveBeenCalledWith(file, '')
  })

  it('同名照片 + MOV 显示实况照片选择，修照片走现有修图入口', async () => {
    const onPick = vi.fn()
    const onRecordVideo = vi.fn()
    await act(async () => {
      root.render(<Uploader onPick={onPick} onRecordVideo={onRecordVideo} />)
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    expect(input.accept).toContain('.mov')
    expect(input.accept).toContain('video/quicktime')
    const image = new File(['image'], 'IMG_2001.HEIC', { type: 'image/heic' })
    const movie = new File(['movie'], 'IMG_2001.MOV', { type: 'video/quicktime' })
    Object.defineProperty(input, 'files', { value: [image, movie], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('找到实况照片')
    expect(container.textContent).toContain('IMG_2001.HEIC')
    expect(container.textContent).toContain('IMG_2001.MOV')
    const edit = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '修照片')!
    await act(async () => { edit.click() })
    expect(onPick).toHaveBeenCalledWith(image, '')
    expect(onRecordVideo).not.toHaveBeenCalled()
  })

  it('选择实况照片时优先把完整配对交给上层，不只交静帧', async () => {
    const onPick = vi.fn()
    const onPickLivePhoto = vi.fn()
    await act(async () => {
      root.render(
        <Uploader onPick={onPick} onPickLivePhoto={onPickLivePhoto} />,
      )
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const image = new File(['image'], 'IMG_2002.JPG', { type: 'image/jpeg' })
    const movie = new File(['movie'], 'IMG_2002.MOV', { type: 'video/quicktime' })
    Object.defineProperty(input, 'files', { value: [image, movie], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const edit = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '修照片')!
    await act(async () => { edit.click() })
    expect(onPickLivePhoto).toHaveBeenCalledWith({ image, movie }, '')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('照片和 MOV 带同一 Apple 实况标识时显示已核对', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const id = '12345678-1234-5678-9abc-def012345678'
    const image = new File(
      [`Apple MakerNote ${id}`],
      'IMG_2101.JPG',
      { type: 'image/jpeg' },
    )
    const movie = new File(
      [`com.apple.quicktime.content.identifier ${id}`],
      'IMG_2101.MOV',
      { type: 'video/quicktime' },
    )
    Object.defineProperty(input, 'files', { value: [image, movie], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    const proof = container.querySelector('.live-photo-proof.verified')
    expect(proof?.textContent).toContain('Apple 实况标识一致')
  })

  it('实况照片可以改选动作短片，也允许收起这次选择', async () => {
    const onPick = vi.fn()
    const onRecordVideo = vi.fn()
    await act(async () => {
      root.render(<Uploader onPick={onPick} onRecordVideo={onRecordVideo} />)
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const image = new File(['image'], 'IMG_2002.JPG', { type: 'image/jpeg' })
    const movie = new File(['movie'], 'IMG_2002.mov', { type: 'video/quicktime' })
    Object.defineProperty(input, 'files', { value: [image, movie], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const motion = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '调动作')!
    await act(async () => { motion.click() })
    expect(onRecordVideo).toHaveBeenCalledWith(movie)
    expect(onPick).not.toHaveBeenCalled()

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const dismiss = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '不用了')!
    await act(async () => { dismiss.click() })
    expect(container.textContent).not.toContain('找到实况照片')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('一次选到多组实况照片时逐组列出，并能把全部静帧送进批量处理', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    const onRecordVideo = vi.fn()
    await act(async () => {
      root.render(
        <Uploader
          onPick={onPick}
          onPickMany={onPickMany}
          onRecordVideo={onRecordVideo}
        />,
      )
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const imageOne = new File(['image-1'], 'IMG_2003.JPG', { type: 'image/jpeg' })
    const movieOne = new File(['movie-1'], 'IMG_2003.MOV', { type: 'video/quicktime' })
    const imageTwo = new File(['image-2'], 'IMG_2004.HEIC', { type: 'image/heic' })
    const movieTwo = new File(['movie-2'], 'IMG_2004.mov', { type: 'video/quicktime' })
    Object.defineProperty(input, 'files', {
      value: [imageOne, movieOne, imageTwo, movieTwo], configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('找到 2 组实况照片')
    expect(container.querySelector('[aria-label="修照片 IMG_2003.JPG"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="调动作 IMG_2004.mov"]')).toBeTruthy()
    const batch = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '全部修照片')!
    await act(async () => { batch.click() })
    expect(onPickMany).toHaveBeenCalledWith([imageOne, imageTwo], '')
    expect(onPick).not.toHaveBeenCalled()
    expect(onRecordVideo).not.toHaveBeenCalled()
  })

  it('多组实况照片可以只打开其中一组的照片或动作', async () => {
    const onPick = vi.fn()
    const onPickMany = vi.fn()
    const onRecordVideo = vi.fn()
    await act(async () => {
      root.render(
        <Uploader
          onPick={onPick}
          onPickMany={onPickMany}
          onRecordVideo={onRecordVideo}
        />,
      )
    })
    const input = container.querySelector('input[data-photo-picker]') as HTMLInputElement
    const imageOne = new File(['image-1'], 'IMG_2005.JPG', { type: 'image/jpeg' })
    const movieOne = new File(['movie-1'], 'IMG_2005.MOV', { type: 'video/quicktime' })
    const imageTwo = new File(['image-2'], 'IMG_2006.HEIC', { type: 'image/heic' })
    const movieTwo = new File(['movie-2'], 'IMG_2006.mov', { type: 'video/quicktime' })
    Object.defineProperty(input, 'files', {
      value: [imageOne, movieOne, imageTwo, movieTwo], configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const motion = container.querySelector(
      '[aria-label="调动作 IMG_2006.mov"]',
    ) as HTMLButtonElement
    await act(async () => { motion.click() })
    expect(onRecordVideo).toHaveBeenCalledWith(movieTwo)

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const photo = container.querySelector(
      '[aria-label="修照片 IMG_2005.JPG"]',
    ) as HTMLButtonElement
    await act(async () => { photo.click() })
    expect(onPick).toHaveBeenCalledWith(imageOne, '')
    expect(onPickMany).not.toHaveBeenCalled()
  })

  it('自拍入口调起前置摄像头，照片同样带上输入的话', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    const wish = container.querySelector('[aria-label="想怎么改"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(wish, '自然一点')
      wish.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const camera = container.querySelector('input[capture="user"]') as HTMLInputElement
    expect(camera).toBeTruthy()
    const clickSpy = vi.spyOn(camera, 'click')
    act(() => { (container.querySelector('[aria-label="自拍"]') as HTMLButtonElement).click() })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const file = new File(['x'], 'selfie.jpg', { type: 'image/jpeg' })
    Object.defineProperty(camera, 'files', { value: [file], configurable: true })
    await act(async () => { camera.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onPick).toHaveBeenCalledWith(file, '自然一点')
  })

  it('光标在输入框里时不抢文本粘贴', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    const wish = container.querySelector('[aria-label="想怎么改"]') as HTMLInputElement
    const file = new File(['x'], 'clipboard.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    })
    await act(async () => { wish.dispatchEvent(paste) })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('实时相机入口打开取景弹层，关闭后收掉', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    await act(async () => {
      (container.querySelector('[aria-label="实时相机"]') as HTMLButtonElement).click()
    })
    await waitFor(() => !!document.querySelector('[aria-label="关闭相机"]'), '相机弹层')
    expect(document.body.textContent).toContain('实时相机')
    await act(async () => {
      (document.querySelector('[aria-label="关闭相机"]') as HTMLButtonElement).click()
    })
    expect(document.body.textContent).not.toContain('实时相机')
  })

  it('相机桥入口打开本机 tether 面板，关闭后收掉', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<Uploader onPick={onPick} />) })
    await act(async () => {
      (container.querySelector('[aria-label="相机桥"]') as HTMLButtonElement).click()
    })
    await waitFor(() => !!document.querySelector('[aria-label="关闭相机桥"]'), '相机桥弹层')
    expect(document.body.textContent).toContain('相机桥')
    expect(document.body.textContent).toContain('npm run camera:bridge')
    await act(async () => {
      (document.querySelector('[aria-label="关闭相机桥"]') as HTMLButtonElement).click()
    })
    expect(document.body.textContent).not.toContain('npm run camera:bridge')
  })
})
