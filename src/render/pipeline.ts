import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'
import { VERTEX_SRC, FRAGMENT_SRC } from './shader'
import { fitToLimit, readLimit } from './limits'
import { UNIFORM_NAMES, uniformValues, type UniformName } from './uniforms'
import { computeHistogram, type HistogramData } from './histogram'
import { clippingMaskPixels } from './clipping'

export const HISTOGRAM_SIZE = 128

export class TonePipeline {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private program: WebGLProgram
  private texture: WebGLTexture
  private vao: WebGLVertexArrayObject
  private buffer: WebGLBuffer
  private uniforms = new Map<UniformName, WebGLUniformLocation | null>()
  private uTexel: WebGLUniformLocation | null = null
  private lutTex: WebGLTexture
  private histTex: WebGLTexture | null = null
  private histFbo: WebGLFramebuffer | null = null
  private lutOn = 0
  private uLutOn: WebGLUniformLocation | null = null
  private uLutAmount: WebGLUniformLocation | null = null
  private uLutDomainMin: WebGLUniformLocation | null = null
  private uLutDomainMax: WebGLUniformLocation | null = null
  private imageW = 0
  private imageH = 0
  private onFatal?: (err: Error) => void
  private contextLostHandler: (e: Event) => void

  /**
   * `onFatal` 是「渲染没救了」的统一出口（上下文丢失），调用方负责提示用户；
   * 没传就只写控制台。
   */
  constructor(canvas: HTMLCanvasElement, onFatal?: (err: Error) => void) {
    this.canvas = canvas
    this.onFatal = onFatal
    const gl = canvas.getContext('webgl2', {
      // ★ 2026-10-17（透明抠图）：alpha 必须真的进绘图缓冲，否则擦掉的背景
      //   在屏幕和 PNG 导出里都会变成不透明黑块。
      alpha: true,
      premultipliedAlpha: false,
      // 导出走的是 canvas.toBlob()，它读的就是绘图缓冲。不开这个标志时，
      // 浏览器在合成之后可以随时清空缓冲，toBlob 有概率拍到一张空图。
      // （readPixels 只给测试用，不是保留它的理由。）
      preserveDrawingBuffer: true,
    })
    if (!gl) throw new Error('这个浏览器不支持 WebGL2')
    this.gl = gl

    this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC)

    const positions = new Float32Array([-1, -1, 3, -1, -1, 3])
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    this.vao = vao!
    // 存下来，dispose 时要删——不然每 new 一个 TonePipeline 就漏一个 buffer
    this.buffer = buf!

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.texture = tex!

    for (const n of UNIFORM_NAMES) {
      this.uniforms.set(n, gl.getUniformLocation(this.program, n))
    }
    this.uTexel = gl.getUniformLocation(this.program, 'uTexel')
    gl.useProgram(this.program)
    gl.uniform1i(gl.getUniformLocation(this.program, 'uImage'), 0)

    // 3D 纹理：没装滤镜时也**必须绑一个**（采样落在"没有纹理"上是未定义行为），
    // 所以先建一个 1×1×1 的白点当占位。
    const lut = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, lut)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE)
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]))
    gl.activeTexture(gl.TEXTURE0)
    this.lutTex = lut!
    this.uLutOn = gl.getUniformLocation(this.program, 'uLutOn')
    this.uLutAmount = gl.getUniformLocation(this.program, 'uLutAmount')
    this.uLutDomainMin = gl.getUniformLocation(this.program, 'uLutDomainMin')
    this.uLutDomainMax = gl.getUniformLocation(this.program, 'uLutDomainMax')
    gl.uniform1i(gl.getUniformLocation(this.program, 'uLut'), 1)

    // 直方图用的小离屏缓冲：128×128 足够看分布，readPixels 也只有 64KB。
    // 它和屏幕上那张大图走同一个 program / 同一套 uniform；失败时只关掉
    // 直方图，不影响正常渲染。
    const histTex = gl.createTexture()
    const histFbo = gl.createFramebuffer()
    if (histTex && histFbo) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, histTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, HISTOGRAM_SIZE, HISTOGRAM_SIZE,
        0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, histFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, histTex, 0)
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.activeTexture(gl.TEXTURE0)
      if (ok) {
        this.histTex = histTex
        this.histFbo = histFbo
      } else {
        gl.deleteTexture(histTex)
        gl.deleteFramebuffer(histFbo)
        console.warn('直方图离屏缓冲不可用，调色面板将不显示直方图')
      }
    }

    // 上下文丢失默认是**静默**的：没有任何事件处理，画布直接变白。
    // preventDefault() 表明这次丢失已被处理（也是浏览器后续尝试恢复的前提），
    // 然后把错误交给调用方走同一条用户可见的提示路径。
    this.contextLostHandler = (e: Event) => {
      e.preventDefault()
      const err = new Error('WebGL2 上下文丢失（画布超出浏览器上限或显存不足）')
      if (this.onFatal) this.onFatal(err)
      else console.error(err, e)
    }
    canvas.addEventListener('webglcontextlost', this.contextLostHandler)
  }

  /**
   * 尺寸能不能渲染，在**上传纹理之前**判掉。
   *
   * 这是**兜底**，正常情况下不该响：上传时 App 已经用 `fitToLimit` 把超大图缩到
   * 画得动了（见 App.tsx 的 fitToDevice）。留着它是因为「上传时判对了」和
   * 「画布这里画得动」必须是同一件事的两面 —— 万一有一头漏了，这里抛错至少
   * 能让用户看到一句准确的提示，而不是拿到一块白画布（白画布会被保存按钮
   * 当成品导出去，那才是最坏的结果）。
   *
   * 「超限」的判定直接复用 `fitToLimit` 的结果，而不是在这里另写一遍比较：
   * 两处各写一遍，早晚会有一处改动而另一处没跟上，于是 App 以为缩好了、
   * 这里照样抛错 —— 又回到「用户什么都拿不到」。
   */
  private checkLimits(w: number, h: number): void {
    const limit = readLimit(this.gl)
    const fit = fitToLimit(w, h, limit)
    if (fit.width === w && fit.height === h) return

    const areaNote = limit.maxArea !== null ? `、面积 ${limit.maxArea}px` : ''
    throw new Error(
      `这张照片 ${w}×${h}（约 ${(w * h / 1e6).toFixed(1)} MP）超出本浏览器的画布上限` +
      `（单边 ${limit.maxSide}px${areaNote}），无法在不缩图的前提下处理`,
    )
  }

  setImage(img: DecodedImage): void {
    this.checkLimits(img.width, img.height)
    const gl = this.gl
    this.imageW = img.width
    this.imageH = img.height
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // 这里不用（也设不了）UNPACK_FLIP_Y_WEBGL：源是 ImageBitmap 时
    // WebGL 会忽略该开关，上下方向由顶点着色器翻转 V 轴处理。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.bitmap)
  }

  /**
   * 换一个滤镜（null = 摘掉）。**amount 不在这里**：它由 `render` 的第二个参数给。
   * 两个来源分开是有意的 —— "换了 cube 忘了换 amount"这种错一眼看得出来。
   */
  setLut(cube: Cube | null): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex)
    if (cube) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, cube.size, cube.size, cube.size,
        0, gl.RGBA, gl.UNSIGNED_BYTE, cube.rgba)
      gl.uniform3f(this.uLutDomainMin, ...cube.domainMin)
      gl.uniform3f(this.uLutDomainMax, ...cube.domainMax)
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]))
    }
    gl.activeTexture(gl.TEXTURE0)
    this.lutOn = cube ? 1 : 0
  }

  resizeToImage(): void {
    this.canvas.width = this.imageW
    this.canvas.height = this.imageH
  }

  /**
   * 入参是 `[-100, 100]` 的原始参数，不是 `[-1, 1]` 的 Unit：
   * 两者结构相同，传错了（比如 exposure: 100）类型也过，但画面会算成 2^100。
   * 换算（`toUnit` + 名字映射）搬去了 `./uniforms` 的 `uniformValues`
   * —— 和以后小程序版的管线共用一份，别在这里另写一份映射。
   *
   * `lutAmount` 是 0–100 的原始强度（和 `Adjustments` 同一个量纲习惯）。
   * ⚠️ 这里**不判 cube 在不在** —— 那件事只有 `setLut` 知道（它算 `lutOn`），
   * 两个来源各管各的，调用方拼错了也吵不起来。
   */
  private setUniforms(a: Adjustments, lutAmount: number): void {
    const gl = this.gl
    gl.uniform2f(this.uTexel, 1 / this.imageW, 1 / this.imageH)
    const map = uniformValues(a)
    for (const n of UNIFORM_NAMES) {
      gl.uniform1f(this.uniforms.get(n) ?? null, map[n])
    }
    gl.uniform1f(this.uLutOn, this.lutOn)
    gl.uniform1f(this.uLutAmount, Math.max(0, Math.min(100, lutAmount)) / 100)
  }

  render(a: Adjustments, lutAmount = 0): void {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    this.setUniforms(a, lutAmount)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * 用同一套 program / uniform 在 128×128 的离屏缓冲上再画一遍，读回来算直方图。
   * 它不碰屏幕上的默认 framebuffer —— 调用完默认缓冲里仍是 `render()` 那一帧。
   */
  readHistogram(a: Adjustments, lutAmount = 0): HistogramData | null {
    const gl = this.gl
    if (!this.histFbo) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo)
    gl.viewport(0, 0, HISTOGRAM_SIZE, HISTOGRAM_SIZE)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    this.setUniforms(a, lutAmount)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const out = new Uint8Array(HISTOGRAM_SIZE * HISTOGRAM_SIZE * 4)
    gl.readPixels(0, 0, HISTOGRAM_SIZE, HISTOGRAM_SIZE,
      gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    return computeHistogram(out, 64, HISTOGRAM_SIZE, HISTOGRAM_SIZE)
  }

  /**
   * 同一套离屏渲染结果只用来生成查看辅助的裁切 mask。
   * 0 = 正常，1 = 高光，2 = 阴影。screen 主画布和导出都不被改写。
   */
  readClippingMask(
    a: Adjustments, lutAmount = 0,
  ): { mask: Uint8Array; width: number; height: number } | null {
    const gl = this.gl
    if (!this.histFbo) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo)
    gl.viewport(0, 0, HISTOGRAM_SIZE, HISTOGRAM_SIZE)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    this.setUniforms(a, lutAmount)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const pixels = new Uint8Array(HISTOGRAM_SIZE * HISTOGRAM_SIZE * 4)
    gl.readPixels(0, 0, HISTOGRAM_SIZE, HISTOGRAM_SIZE,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    return clippingMaskPixels(pixels, HISTOGRAM_SIZE, HISTOGRAM_SIZE)
  }

  /**
   * 仅测试用：读回画布像素（RGBA, 8bit）。
   *
   * 行序遵循 GL 约定——**自下而上**，与图片文件的自上而下相反。
   * 直接把这批字节当图片编码会上下颠倒，用之前要先翻行。
   */
  readPixels(): Uint8Array {
    const gl = this.gl
    const w = this.canvas.width
    const h = this.canvas.height
    const out = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return out
  }

  dispose(): void {
    // 先摘监听再删资源：上下文已经丢失时 delete* 是空操作，但监听留着
    // 会一直抓着 this，也会在下一次丢失时重复弹提示。
    this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler)
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteTexture(this.texture)
    gl.deleteTexture(this.lutTex)
    if (this.histTex) gl.deleteTexture(this.histTex)
    if (this.histFbo) gl.deleteFramebuffer(this.histFbo)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.buffer)
  }
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const p = gl.createProgram()
  if (!p) throw new Error('创建着色器程序失败')
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('链接着色器失败: ' + gl.getProgramInfoLog(p))
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return p
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('创建着色器失败')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('编译着色器失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}
