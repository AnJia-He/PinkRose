import { toUnit, type Adjustments } from '../core/adjustments'
import type { DecodedImage } from '../image/decode'
import { VERTEX_SRC, FRAGMENT_SRC } from './shader'

const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
] as const

type UniformName = typeof UNIFORM_NAMES[number]

/**
 * 画布面积上限（总像素数），**只对 iOS 系生效**。
 *
 * iOS Safari 长期把 canvas 面积压在约 1670 万像素（16.7 MP），这条限制
 * GPU 不会通过 MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS 报出来，超了也不报错，
 * 而是**静默失败**：WebGL 画不出东西，用户拿到一块白画布，而保存按钮还会
 * 把这些白像素当成品导出去。真实的 iPhone 原图 4032×3024 ≈ 12.2 MP 已经
 * 贴在这条线上，48 MP 远超。
 *
 * 其他平台不套这个常量：桌面 Chrome/Firefox 渲染 2000 万像素以上的图没有
 * 问题，一刀切只会把它们无谓拒掉。那边按设备自报的 MAX_TEXTURE_SIZE /
 * MAX_VIEWPORT_DIMS 判就够了。
 */
const MAX_CANVAS_AREA = 16777216

/**
 * 是不是 iOS 系浏览器。
 *
 * 除了 iPhone/iPad/iPod 的 UA，还要认 iPadOS 13+ 的「伪装成 Mac」：它的 UA
 * 与桌面 Safari 一模一样，只能靠「平台报 Mac 却支持多点触控」来区分。
 */
function isIOS(): boolean {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true
  return navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform)
}

export class TonePipeline {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private program: WebGLProgram
  private texture: WebGLTexture
  private vao: WebGLVertexArrayObject
  private buffer: WebGLBuffer
  private uniforms = new Map<UniformName, WebGLUniformLocation | null>()
  private uTexel: WebGLUniformLocation | null = null
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
      alpha: false,
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
   * 超限就抛错，不静默缩图——「调色不缩图」是产品铁律（spec §4.4），
   * 悄悄缩小等于骗用户；抛错则让调用方明确告诉用户这张图处理不了。
   */
  private checkLimits(w: number, h: number): void {
    const gl = this.gl
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    // MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS 是设备自报的真实上限，所有平台都按它判；
    // 16.7 MP 面积上限是 iOS 特有的（原因见 MAX_CANVAS_AREA 的注释），只额外套在 iOS 上。
    const ios = isIOS()
    const over =
      w > maxTex || h > maxTex ||
      w > maxView[0] || h > maxView[1] ||
      (ios && w * h > MAX_CANVAS_AREA)
    if (over) {
      const areaNote = ios ? `、面积 ${MAX_CANVAS_AREA}px` : ''
      throw new Error(
        `这张照片 ${w}×${h}（约 ${(w * h / 1e6).toFixed(1)} MP）超出本浏览器的画布上限` +
        `（单边 ${maxTex}px${areaNote}），无法在不缩图的前提下处理`,
      )
    }
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

  resizeToImage(): void {
    this.canvas.width = this.imageW
    this.canvas.height = this.imageH
  }

  /**
   * 入参是 `[-100, 100]` 的原始参数，不是 `[-1, 1]` 的 Unit：
   * 两者结构相同，传错了（比如 exposure: 100）类型也过，但画面会算成 2^100。
   * `toUnit` 是全项目唯一的映射入口，就在这里调用。
   */
  render(a: Adjustments): void {
    const u = toUnit(a)
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)

    gl.uniform2f(this.uTexel, 1 / this.imageW, 1 / this.imageH)
    const map: Record<UniformName, number> = {
      uExposure: u.exposure,
      uContrast: u.contrast,
      uHighlights: u.highlights,
      uShadows: u.shadows,
      uSaturation: u.saturation,
      uTemperature: u.temperature,
      uClarity: u.clarity,
      uVignette: u.vignette,
    }
    for (const n of UNIFORM_NAMES) {
      gl.uniform1f(this.uniforms.get(n) ?? null, map[n])
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
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
