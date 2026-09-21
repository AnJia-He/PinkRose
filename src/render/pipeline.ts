import type { Unit } from '../core/tone'
import type { DecodedImage } from '../image/decode'
import { VERTEX_SRC, FRAGMENT_SRC } from './shader'

const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
] as const

type UniformName = typeof UNIFORM_NAMES[number]

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,   // 导出时需要 readPixels
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
  }

  setImage(img: DecodedImage): void {
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

  render(u: Unit): void {
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
