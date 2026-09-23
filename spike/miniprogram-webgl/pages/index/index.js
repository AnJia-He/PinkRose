/**
 * 探针：小程序里的 WebGL 到底能干什么。
 *
 * 要回答四个问题：
 *   ① 有没有 WebGL？是 1 还是 2？
 *   ② 单边纹理上限是多少？
 *   ③ 上限是不是**真的**？（自报能画，不代表画出来不是一块白板）
 *   ④ 一张真照片要缩到多大才画得动？
 *
 * ── 第一版探针自己错在哪（2026-09-23，真机上跑了才发现）────────────
 *
 * 第一版**每一档都报「1 种颜色 = 静默失败」**，而画布左下角明明露着
 * 我画的条纹。错在采样点上：我按 1024×1024 去撒点，但那块探针画布
 * CSS 只有 60rpx —— **绘图缓冲区根本没这么大，采样全落在缓冲区外面，
 * 读回来一律是 0**。于是"什么都没读到"被我报成了"画不出来"。
 *
 * 同一个坑今天第三次了：**出错的不是被测的东西，是量它的那把尺子。**
 * 现在改成一律按 `drawingBufferWidth/Height` 采样，并把**读到的实际颜色**
 * 一并打出来 —— 纯黑（没画）和纯白（静默失败）从此分得开。
 *
 * 第二处：第一版直接把 `canvas.createImage()` 的对象传给 texImage2D，
 * 最大那一档报了 1281（INVALID_VALUE）。现在统一先画进离屏 2D 画布再上传 ——
 * 真做的时候也是这么走的，少一条没意义的依赖。
 *
 * 第三处（改完上面两处之后又踩的）：`q.node()` 我单独写了一行、没接住
 * 它的返回值，然后拿原来的 q 去 exec —— 那个查询根本不知道要取节点，
 * 三个画布全报"节点拿不到"。见 query() 里的注释。
 *
 * 三处都是**探针自己的错**，没有一处是"小程序不行"。这也是为什么探针
 * 得跑两遍：第一遍的结论往往只说明尺子坏了。
 *
 * 答案拿到就把这个目录删掉 —— 它是探针，不是代码。
 */

// GLSL ES 1.00：**故意不写 #version**，webgl1 和 webgl2 都能编译。
const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}`

function query(sel, withSize) {
  return new Promise((resolve, reject) => {
    // ⚠️ 必须**接住** .node()/.fields() 的返回值再 exec。第一版写成
    // `q.node()` 单独一行、然后 q.exec() —— 那个查询根本不知道要取节点，
    // 于是三个画布全报"节点拿不到"。链式 API 里每个方法返回的东西都得接住。
    const base = wx.createSelectorQuery().select(sel)
    const q = withSize ? base.fields({ node: true, size: true }) : base.node()
    q.exec(res => {
      const item = res && res[0]
      const node = item && item.node
      node ? resolve({ node, w: item.width, h: item.height }) : reject(new Error('拿不到节点 ' + sel))
    })
  })
}

function getContext(node, type) {
  try { return node.getContext(type) } catch (e) { return null }
}

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}

function makeProgram(gl) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('链接失败: ' + gl.getProgramInfoLog(p))
  }
  return p
}

/** 把一张图传给纹理。返回 gl.getError()（0 = 没报错）。 */
function upload(gl, source) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  const err = gl.getError()
  if (err !== 0) gl.deleteTexture(tex)
  return { err, tex }
}

/**
 * 真的画一遍，再把像素读回来 —— **这一步才是关键**。
 * 只看 getError() 会漏掉静默失败。
 *
 * ⚠️ 采样点必须落在**绘图缓冲区**里 —— 用 drawingBufferWidth/Height，
 * 不能用自己以为的尺寸。第一版就是拿 1024 去撒点、缓冲区没这么大，
 * 读回来全是 0，被我误报成"画不出来"。
 *
 * 返回 { colors, first } —— colors 是不同颜色数（1 = 纯色），
 * first 是第一个采样点的颜色（"纯黑"和"纯白"靠它分开）。
 */
function drawAndCountColors(gl, tex, W, H) {
  const bw = gl.drawingBufferWidth
  const bh = gl.drawingBufferHeight
  const program = makeProgram(gl)
  gl.useProgram(program)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)

  gl.viewport(0, 0, bw, bh)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const drawErr = gl.getError()

  const px = new Uint8Array(4)
  const seen = {}
  let first = null
  const N = 8
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const sx = Math.floor((i + 0.5) * bw / N)
      const sy = Math.floor((j + 0.5) * bh / N)
      gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const key = px[0] + ',' + px[1] + ',' + px[2]
      seen[key] = 1
      if (first === null) first = key
    }
  }
  gl.deleteProgram(program)
  gl.deleteBuffer(buf)
  return { colors: Object.keys(seen).length, first, bw, bh, drawErr }
}

/** 造一张 N×N 的彩色图案，用来探纹理上限（不依赖相册）。 */
function makePattern(N) {
  const c = wx.createOffscreenCanvas({ type: '2d', width: N, height: N })
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, N, N)
  g.addColorStop(0, '#ff0000')
  g.addColorStop(0.5, '#00ff00')
  g.addColorStop(1, '#0000ff')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, N, N)
  ctx.fillStyle = '#ffffff'
  for (let k = 0; k < 8; k++) ctx.fillRect(k * N / 8, 0, N / 24, N)
  return c
}

/** 把一张图缩到 w×h，返回离屏 2D 画布。
 *  统一走这条路再上传：真做的时候也是这么走的。 */
function toCanvas(img, w, h) {
  const c = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c
}

Page({
  data: { report: '按上面两个按钮，结果会打在这里。', running: false },

  push(line) {
    console.log('[探针]', line)
    this.setData({ report: this.data.report + '\n' + line })
  },

  /** ① 不用照片，先问能力和纹理上限 */
  async probeContexts() {
    this.setData({ report: '=== ① WebGL 能力 ===' })
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    this.push('基础库 ' + info.SDKVersion)

    const TRIES = [
      ['#gl1', ['webgl'], '普通画布 → webgl'],
      ['#gl2', ['webgl2'], 'type="webgl2" 画布 → webgl2'],
      ['#gl3', ['webgl2', 'webgl'], '普通画布 → 先试 webgl2'],
    ]
    for (const [sel, types, label] of TRIES) {
      let node
      try { ({ node } = await query(sel)) } catch (e) { this.push(label + ': 节点拿不到'); continue }

      let gl = null, used = ''
      for (const t of types) {
        gl = getContext(node, t)
        if (gl) { used = t; break }
        this.push(label + ': 试着拿 ' + t + ' → null')
      }
      if (!gl) { this.push(label + ': ❌ 一个都拿不到'); continue }

      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      const vd = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
      this.push(label + ': ✅ 拿到的是 ' + used)
      this.push('   VERSION  ' + gl.getParameter(gl.VERSION))
      this.push('   RENDERER ' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)))
      this.push('   MAX_TEXTURE_SIZE  ' + maxTex)
      this.push('   MAX_VIEWPORT_DIMS ' + (vd ? vd[0] + 'x' + vd[1] : '?'))
      this.push('   绘图缓冲区 ' + gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight)

      for (const N of [2048, 4096].filter(n => n <= maxTex)) {
        try {
          const pat = makePattern(N)
          const { err, tex } = upload(gl, pat)
          if (err !== 0) { this.push('   试 ' + N + ': ❌ 上传报错 ' + err); continue }
          const r = drawAndCountColors(gl, tex, N, N)
          this.push('   试 ' + N + ': 缓冲区 ' + r.bw + 'x' + r.bh + '，数出 ' + r.colors +
            ' 种颜色，第一个像素 (' + r.first + ')' +
            (r.colors > 1 ? ' ✅ 真画出来了' : ' ❌ 纯色（看上面那个像素值判断是黑还是白）'))
          if (r.drawErr) this.push('      ⚠️ drawArrays 之后 gl.getError() = ' + r.drawErr)
          gl.deleteTexture(tex)
        } catch (e) {
          this.push('   试 ' + N + ': ❌ ' + (e.message || e))
        }
      }
    }
  },

  /** ② 一张真照片，要缩到多大才画得动 */
  async probePhoto() {
    if (this.data.running) return
    this.setData({ running: true, report: '=== ② 真照片 ===' })
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['original'] })
      const file = res.tempFiles[0]
      const info = await new Promise((ok, no) =>
        wx.getImageInfo({ src: file.tempFilePath, success: ok, fail: no }))
      this.push('照片 ' + info.width + 'x' + info.height +
        ' (' + (info.width * info.height / 1e6).toFixed(1) + ' MP)，' +
        Math.round((file.size || 0) / 1024) + ' KB')

      const { node } = await query('#gl1')
      const gl = getContext(node, 'webgl')
      if (!gl) { this.push('❌ 拿不到 webgl 上下文'); return }

      const img = await new Promise((ok, no) => {
        const im = node.createImage()
        im.onload = () => ok(im)
        im.onerror = () => no(new Error('图片加载不进 canvas'))
        im.src = file.tempFilePath
      })
      this.push('✅ 图片加载进 canvas 了（' + img.width + 'x' + img.height + '）')
      this.push('   绘图缓冲区 ' + gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight)

      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      this.push('   MAX_TEXTURE_SIZE ' + maxTex)
      let w = info.width, h = info.height
      for (let step = 0; step < 10; step++) {
        try {
          const c = toCanvas(img, w, h)
          const t0 = Date.now()
          const { err, tex } = upload(gl, c)
          const ms = Date.now() - t0
          if (err === 0) {
            const r = drawAndCountColors(gl, tex, w, h)
            this.push(' ' + w + 'x' + h + ': 上传 ' + ms + 'ms，' + r.colors + ' 种颜色，第一个像素 (' +
              r.first + ')' + (r.colors > 1 ? ' ✅ 画出来了' : ' ❌ 纯色'))
            gl.deleteTexture(tex)
            if (r.colors > 1) {
              this.push('>>> 结论：缩到 ' + w + 'x' + h + ' 就能画（单边上限 ' + maxTex + '）')
              break
            }
          } else {
            this.push(' ' + w + 'x' + h + ': ❌ 上传报错 ' + err)
          }
        } catch (e) {
          this.push(' ' + w + 'x' + h + ': ❌ ' + (e.errMsg || e.message || e))
        }
        w = Math.floor(w * 0.75)
        h = Math.floor(h * 0.75)
        if (w < 64) { this.push('>>> 缩到 64 还画不出来，见上面每档的报错'); break }
      }
    } catch (e) {
      this.push('❌ ' + (e.errMsg || e.message || String(e)))
    } finally {
      this.setData({ running: false })
    }
  },
})
