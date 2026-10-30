#!/usr/bin/env node
/** 检测浏览器是否具备 P3 编辑所需的 2D / WebGL 色彩空间能力。 */
import { chromium, webkit } from 'playwright'

async function probe(name, launcher) {
  const browser = await launcher.launch()
  try {
    const page = await browser.newPage()
    await page.goto('data:text/html,<canvas id="c"></canvas>')
    return await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const gl = canvas.getContext('webgl2')
      let context2d = null
      try {
        context2d = document.createElement('canvas').getContext('2d', {
          colorSpace: 'display-p3',
        })
      } catch {}
      let srgbRedInP3 = null
      let p3RedInP3 = null
      if (context2d) {
        context2d.canvas.width = 2
        context2d.canvas.height = 1
        context2d.fillStyle = 'rgb(100% 0% 0%)'
        context2d.fillRect(0, 0, 1, 1)
        context2d.fillStyle = 'color(display-p3 1 0 0)'
        context2d.fillRect(1, 0, 1, 1)
        srgbRedInP3 = [...context2d.getImageData(0, 0, 1, 1).data.slice(0, 3)]
        p3RedInP3 = [...context2d.getImageData(1, 0, 1, 1).data.slice(0, 3)]
      }
      return {
        webgl2: !!gl,
        drawingBufferColorSpace: gl ? 'drawingBufferColorSpace' in gl : false,
        drawingBufferColorSpaceValue: gl && 'drawingBufferColorSpace' in gl
          ? gl.drawingBufferColorSpace : null,
        unpackColorSpace: gl ? 'unpackColorSpace' in gl : false,
        canvas2dP3: !!context2d,
        canvas2dColorSpace: context2d?.getContextAttributes?.().colorSpace ?? null,
        srgbRedInP3,
        p3RedInP3,
        createImageBitmap: typeof createImageBitmap === 'function',
      }
    })
  } finally {
    await browser.close()
  }
}

const chromiumResult = await probe('chromium', chromium)
const webkitResult = await probe('webkit', webkit)
console.log(JSON.stringify({ chromium: chromiumResult, webkit: webkitResult }, null, 2))
if (!chromiumResult.webgl2 || !webkitResult.webgl2) process.exitCode = 1
