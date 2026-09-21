/**
 * 八参数调色，单个 fragment shader 一次算完（spec §5.2）。
 *
 * 调色链的顺序必须与 src/core/tone.ts 的 applyTone 严格一致——两者共有
 * 六个参数：色温 / 曝光 / 高光 / 阴影 / 对比度 / 饱和度。
 *
 * 清晰度和暗角**只有本文件有**：它们分别需要邻域像素和像素坐标，
 * tone.ts 的单像素函数表达不了，没有可对照的实现。
 *
 * 改任何一边都必须同步改另一边。**本渲染器没有自动化测试**——
 * WebGL 要真实 GPU，写死像素的测试会很脆；正确性靠 Task 7 的浏览器验收。
 */
export const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // V 轴必须翻转。
  // texImage2D 把图像的第一行（顶行）放在 t=0，而 gl_Position.y = -1
  // 是屏幕底部——不翻的话画面上下颠倒。
  //
  // 注意：源是 ImageBitmap 时 UNPACK_FLIP_Y_WEBGL 会被 WebGL 忽略
  // （规范如此；ImageBitmap 的方向由创建时的 imageOrientation 决定），
  // 所以那个开关修不了这件事，只能在着色器里翻。
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform vec2  uTexel;       // 1.0 / 纹理尺寸
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uSaturation;
uniform float uTemperature;
uniform float uClarity;
uniform float uVignette;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// 注意 max(..., 0.0) 这两处不是多余的：
//   mix(x, y, a) 的语义是 x*(1-a) + y*a —— 两个分支**都会被求值**，
//   而 GLSL 规定 pow 的底数为负时结果未定义（实际会出 NaN），
//   NaN * 0 仍是 NaN，所以哪怕该分支最终会被丢弃，也会把 NaN 带进结果。
//
//   底数确实可能为负：温度 +100 时蓝通道减 0.1（暗部即负），
//   或清晰度在高反差边缘欠冲（base=0.1 / blur=0.5 → -0.14）。
//
//   tone.ts 用的是三元运算符，负值根本不进 pow，所以那边没这个问题——
//   这是 TS 与 GLSL 的真实行为分歧，不是精度差异。
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92,
             pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)),
             step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92,
             1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  // 0. 清晰度 —— 必须放在整条调色链的最前面，作用在原始纹理上。
  //
  //    放在后面是错的：那时 c 已经过曝光/对比度等处理，而 blur 采的还是
  //    原始像素，(c - blur) 里就混进一个全局亮度差，拖清晰度会顺带把
  //    整张图弄亮或弄暗。放在最前面时，平坦区域的 c - blur 恒为 0，
  //    清晰度就只影响局部细节。
  vec3 base = texture(uImage, uv).rgb;
  vec3 blur = (
      texture(uImage, uv + vec2(-uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2( uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2(0.0, -uTexel.y)).rgb
    + texture(uImage, uv + vec2(0.0,  uTexel.y)).rgb
  ) * 0.25;
  vec3 c = base + uClarity * 0.6 * (base - blur);

  // 1. 色温
  c.r += uTemperature * 0.10;
  c.b -= uTemperature * 0.10;

  // 2. 曝光（线性空间）
  c = srgbToLinear(c);
  c *= pow(2.0, uExposure);
  c = linearToSrgb(c);

  // 3. 高光 / 阴影
  float l = dot(c, LUMA);
  float hiW = smoothstep(0.5, 1.0, l) * 0.35 * uHighlights;
  float loW = (1.0 - smoothstep(0.0, 0.5, l)) * 0.35 * uShadows;
  c += vec3(hiW + loW);

  // 4. 对比度（中灰支点）
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // 5. 饱和度
  float l2 = dot(c, LUMA);
  c = vec3(l2) + (c - vec3(l2)) * (1.0 + uSaturation);

  // 6. 暗角
  //
  //    只钳下界（max），不钳上界。负的 uVignette 会让 vig > 1——
  //    那是「提亮四角」。若在这里钳到 1，滑块的负半程就完全没反应
  //    （滑块范围是 -100~100，负半程却是死的，用户会以为坏了）。
  //    溢出由最后那句 clamp(c, 0.0, 1.0) 兜住。
  vec2 d = uv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 3.5;
  c *= max(vig, 0.0);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`
