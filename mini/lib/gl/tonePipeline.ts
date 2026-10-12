import type { Adjustments } from '../shared/adjustments'
import type { Cube } from '../shared/lut'
import { VERTEX_SRC, FRAGMENT_SRC } from '../shared/shader'
import { UNIFORM_NAMES, uniformValues, type UniformName } from '../shared/uniforms'

/**
 * 小程序版的渲染管线 —— 电脑版 `src/render/pipeline.ts` 的移植。
 *
 * 结构照着电脑版写（程序编译 / VAO + 全屏三角形 / 纹理参数 / uniform 循环 /
 * drawArrays），**只有三件事换了平台写法**（三条都来自 2026-09 的真机探针，
 * 源码在 `archive/spike/miniprogram-webgl/`）：
 *
 *   ① 拿上下文：节点来自 pages 层的 selectorQuery（见 pages/index/index.ts）。
 *      必须是 `type="webgl2"` 的画布 —— 探针实测：普通画布在模拟器上要 webgl2
 *      会给 null，只有 type="webgl2" 的画布两条路都拿得到。
 *   ② 上传图片：`node.createImage()` 加载 → 离屏 2D 画布 drawImage →
 *      `texImage2D(..., 那张 2D 画布)`。**不能把 image 对象直接交给 texImage2D**
 *      —— 探针第一版那么干，最大那一档报了 1281（GL_INVALID_VALUE）。
 *   ③ 上下文丢失：小程序**没有** `webglcontextlost` 事件 —— 电脑版那段监听
 *      整个不搬。丢了上下文的表现是画布不再更新，没有任何事件可挂（见构造器里
 *      `onFatal` 的说明）。
 *
 * 照抄不动的部分：`preserveDrawingBuffer`（导出要读绘图缓冲，和电脑版同一条
 * 理由）、VAO + 全屏三角形、V 轴翻转（在共享的顶点着色器里）、15 个参数的
 * 换算（共享 `uniforms.ts` 的 `uniformValues`，两边不许各写一份）、
 * **LUT 永远在管线最后**（契约，见共享 `shader.ts`）。
 *
 * ⚠️ 这份文件里没有任何浏览器/DOM 成分，也**不许**出现：它要能被小程序编译
 * （`npx tsc -p mini --noEmit` 过闸）。
 */

/** 小程序侧的 GL 类型：api-typings 自带一份，和浏览器 lib.dom 那套同名不同源。 */
type GL = WechatMiniprogram.CanvasRenderingContext.WebGL2RenderingContext
type GLProgram = WechatMiniprogram.CanvasRenderingContext.WebGLProgram
type GLShader = WechatMiniprogram.CanvasRenderingContext.WebGLShader
type GLTexture = WechatMiniprogram.CanvasRenderingContext.WebGLTexture
type GLBuffer = WechatMiniprogram.CanvasRenderingContext.WebGLBuffer
type GLVao = WechatMiniprogram.CanvasRenderingContext.WebGLVertexArrayObject
type GLUniform = WechatMiniprogram.CanvasRenderingContext.WebGLUniformLocation

/**
 * selectorQuery 拿回来的画布节点（`fields({ node: true })` 的 `res[1].node`）。
 * api-typings 里它只是个 IAnyObject —— 这里只声明我们用得到的那几个成员，
 * 组成「这个类对节点要求的最小形状」。
 */
export interface CanvasNode {
  /** 拿不到 WebGL2 时小程序返回 null（见构造器里的报错）。
   *  attributes 照电脑版的三件套传（alpha/premultipliedAlpha/preserveDrawingBuffer）——
   *  typings 里只声明了一个参数，但结构上多传一个对象即可（运行时要认，
   *  2026-10-12 模拟器当场验过，见 mini/README.md「已知平台行为」）。 */
  getContext(type: 'webgl2', attributes?: {
    alpha?: boolean
    premultipliedAlpha?: boolean
    preserveDrawingBuffer?: boolean
  }): GL | null
  /** 从这块画布造一张 Image（加载本地临时文件用）。 */
  createImage(): WechatMiniprogram.Image
  /** 画布的绘图缓冲尺寸（可写）。CSS 尺寸归 wxss/inline style 管，见 resizeToImage。 */
  width: number
  height: number
}

export class TonePipeline {
  private gl: GL
  private node: CanvasNode
  private program: GLProgram
  private texture: GLTexture
  private vao: GLVao
  private buffer: GLBuffer
  private uniforms = new Map<UniformName, GLUniform | null>()
  private uTexel: GLUniform | null = null
  private lutTex: GLTexture | null = null
  private lutOk = true
  private lutOn = 0
  private uLutOn: GLUniform | null = null
  private uLutAmount: GLUniform | null = null
  private uLutDomainMin: GLUniform | null = null
  private uLutDomainMax: GLUniform | null = null
  private imageW = 0
  private imageH = 0
  private onFatal?: (err: Error) => void

  /**
   * 小程序特有的入口。电脑版的构造器收的是 `HTMLCanvasElement`，这边收节点。
   *
   * `onFatal` 是「渲染没救了」的统一出口（和电脑版同签名）。⚠️ 小程序这侧
   * **目前没有任何触发点**：电脑版唯一的来源是 `webglcontextlost` 事件，
   * 而这个平台没有这个事件（丢了上下文不会出声，画布只是不再更新）。
   * 参数留着是为了两边签名一致、以后真有出口时不用改调用方。
   */
  static fromCanvasNode(node: CanvasNode, onFatal?: (err: Error) => void): TonePipeline {
    return new TonePipeline(node, onFatal)
  }

  constructor(node: CanvasNode, onFatal?: (err: Error) => void) {
    this.node = node
    // ⚠️ 只存不调：这平台没有"没救了"的信号源（见类头那段）。留字段是为了
    //    以后真接上时不用动调用方 —— 但也别误会它被触发过。
    this.onFatal = onFatal
    const gl = node.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      // 导出要读绘图缓冲（canvas.toDataURL / wx.canvasToTempFilePath 都是），
      // 不开这个标志时合成之后缓冲随时可能被清空 —— 保存有概率拍到一张空图。
      // 和电脑版同一条理由，原样保留。
      preserveDrawingBuffer: true,
    })
    if (!gl) throw new Error('这个设备不支持 WebGL2')
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

    this.uLutOn = gl.getUniformLocation(this.program, 'uLutOn')
    this.uLutAmount = gl.getUniformLocation(this.program, 'uLutAmount')
    this.uLutDomainMin = gl.getUniformLocation(this.program, 'uLutDomainMin')
    this.uLutDomainMax = gl.getUniformLocation(this.program, 'uLutDomainMax')

    // 3D 纹理：没装滤镜时也**必须绑一个**（采样落在"没有纹理"上是未定义行为），
    // 所以先建一个 1×1×1 的白点当占位。电脑版原样。
    //
    // ⚠️ 唯一的平台分歧就在这一步：texImage3D 是 WebGL2 的核心功能，但小程序
    // 这一层壳在个别设备上会直接报错（1280 / 1281 / 1282 都可能，也可能静默）。
    // 所以建完立刻问一次 getError：报错就把 LUT 整体降级 —— 不绑 3D 纹理、
    // `lutOn` 恒 0、`setLut` 变 no-op。坏掉的只是 Lut 这个功能，照片本身照常画。
    // （2026-10-12 探针实测：模拟器上不报错，见 mini/README.md「已知平台行为」。）
    gl.getError() // 先清账：把之前可能挂着的错误倒掉，别把别人的账记在 texImage3D 头上
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
    if (gl.getError() !== gl.NO_ERROR) {
      this.lutOk = false
      gl.deleteTexture(lut)
      console.warn('[TonePipeline] 这台设备建不出 3D 纹理 —— Lut 功能已禁用，照片照常渲染')
    } else {
      this.lutTex = lut
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(gl.getUniformLocation(this.program, 'uLut'), 1)
  }

  setImage(img: WechatMiniprogram.Image): void {
    const gl = this.gl
    this.imageW = img.width
    this.imageH = img.height
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // 平台差异 ②：先画进离屏 2D 画布再上传（探针路径，"传 image 对象报 1281"的教训）。
    // （这里同样不用（也设不了）UNPACK_FLIP_Y_WEBGL：上下方向由顶点着色器翻 V 轴，
    //   电脑版同一套。）
    gl.getError()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, toCanvas(img))
    // ★ 上传失败必须出声。这条不是防手滑，是防**静默**：纹理没上去时画面是
    //   一块黑（或上一张图的残影），而这块黑会被保存按钮当成品导出去 ——
    //   电脑版那条 `checkLimits` 挡的是同一件事的另一头（上传前的尺寸预判）。
    //   实测过的来路：探针第一版把 image 对象直接交给 texImage2D，最大档报 1281，
    //   而画布上没有任何提示。
    const err = gl.getError()
    if (err !== gl.NO_ERROR) {
      throw new Error(
        `这张照片 ${img.width}×${img.height}（约 ${(img.width * img.height / 1e6).toFixed(1)} MP）` +
        `传不上这台设备的显卡（GL 错误 ${err}）`)
    }
  }

  /**
   * 换一个滤镜（null = 摘掉）。**amount 不在这里**：它由 `render` 的第二个参数给。
   * 两个来源分开是有意的 —— "换了 cube 忘了换 amount"这种错一眼看得出来。
   * （这台设备建不出 3D 纹理时整段是 no-op，签名保住，调用方不用分叉。）
   */
  setLut(cube: Cube | null): void {
    if (!this.lutOk || !this.lutTex) return
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

  /**
   * 画布 buffer = 照片原尺寸，**CSS 尺寸不动**（那是 pages 层的事，见 index.ts 的
   * stageW/stageH）—— 和电脑版同款分工：`canvas.width/height` 只管绘图缓冲。
   */
  resizeToImage(): void {
    this.node.width = this.imageW
    this.node.height = this.imageH
  }

  /**
   * 画布最多能开多大（这台设备的 `MAX_TEXTURE_SIZE` 与 `MAX_VIEWPORT_DIMS` 里最小的
   * 那个）—— **全尺寸导出对设备上限的兜底**（见 `lib/image/export.ts`）。
   * 16384 下基本不触发（2026-10-12 模拟器实测：纹理 16384、视口 32767×32767）。
   * 上限一个都读不出来（上下文坏了）时返回 0 —— 调用方按"不设限"处理，别拿它当尺寸用。
   */
  maxCanvasSide(): number {
    const gl = this.gl
    const tex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
    const vw = dims ? Math.abs(Number(dims[0])) || 0 : 0
    const vh = dims ? Math.abs(Number(dims[1])) || 0 : 0
    const sides = [tex, vw, vh].filter(n => n >= 1)
    return sides.length ? Math.min(...sides) : 0
  }

  /**
   * 入参是 `[-100, 100]` 的原始参数，不是 `[-1, 1]` 的 Unit：
   * 两者结构相同，传错了（比如 exposure: 100）类型也过，但画面会算成 2^100。
   * 换算（`toUnit` + 名字映射）走共享 `uniforms.ts` 的 `uniformValues`
   * —— 和电脑版是同一份，别在这里另写一份映射。
   *
   * `lutAmount` 是 0–100 的原始强度（和 `Adjustments` 同一个量纲习惯）。
   * ⚠️ 这里**不判 cube 在不在** —— 那件事只有 `setLut` 知道（它算 `lutOn`），
   * 两个来源各管各的，调用方拼错了也吵不起来。
   */
  render(a: Adjustments, lutAmount = 0): void {
    const gl = this.gl
    gl.viewport(0, 0, this.node.width, this.node.height)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)

    gl.uniform2f(this.uTexel, 1 / this.imageW, 1 / this.imageH)
    const map = uniformValues(a)
    for (const n of UNIFORM_NAMES) {
      gl.uniform1f(this.uniforms.get(n) ?? null, map[n])
    }
    gl.uniform1f(this.uLutOn, this.lutOn)
    gl.uniform1f(this.uLutAmount, Math.max(0, Math.min(100, lutAmount)) / 100)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * 仅测试/探针用：读回画布像素（RGBA, 8bit）。
   *
   * 行序遵循 GL 约定——**自下而上**，与图片文件的自上而下相反。
   * 直接把这批字节当图片编码会上下颠倒，用之前要先翻行。
   */
  readPixels(): Uint8Array {
    const gl = this.gl
    const w = this.node.width
    const h = this.node.height
    const out = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return out
  }

  /**
   * 仅测试/探针用：读一次 GL 错误码（0 = 干净）。⚠️ 和 GL 的 getError 同语义 ——
   * **读一次清一次账**，连着读第二次恒为 0。「全黑哨兵」（pages/index 的
   * `__probeColors`）每档画面读一次就靠它。
   */
  getError(): number {
    return this.gl.getError()
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteTexture(this.texture)
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.buffer)
    // 电脑版在这里还有一步 removeEventListener('webglcontextlost') —— 平台差异 ③：
    // 这个平台没有那个事件，也就没有东西要摘。
  }
}

/**
 * 把一张加载好的图铺到**同尺寸的离屏 2D 画布**上，作为 texImage2D 的源。
 * 单独一步的理由见 setImage 的平台差异 ②。
 */
function toCanvas(img: WechatMiniprogram.Image): WechatMiniprogram.OffscreenCanvas {
  const off = wx.createOffscreenCanvas({ type: '2d', width: img.width, height: img.height })
  off.getContext('2d').drawImage(img, 0, 0)
  return off
}

function linkProgram(gl: GL, vsSrc: string, fsSrc: string): GLProgram {
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

function compile(gl: GL, type: number, src: string): GLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('创建着色器失败')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('编译着色器失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}
