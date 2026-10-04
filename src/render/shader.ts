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
 *
 * 另外：GLSL 字符串里的注释一律用 ASCII 英文。WebGL 规范对 shader source
 * 的字符集有限制，中文注释在无头 Chromium 里能过，但真实设备驱动上
 * 可能直接编译失败，而失败是全量的（整个程序编译不过）。
 * 本文件里 GLSL **字符串之外**的 TS 注释仍按项目习惯用中文。
 */
export const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // The V axis must be flipped.
  // texImage2D puts the image's first row (the top row) at t=0, while
  // gl_Position.y = -1 is the bottom of the screen -- without the flip the
  // image renders upside down.
  //
  // Note: when the source is an ImageBitmap, WebGL ignores
  // UNPACK_FLIP_Y_WEBGL (per spec; an ImageBitmap's orientation is decided
  // by the imageOrientation option given at creation time), so that switch
  // cannot fix this -- it has to be done in the shader.
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform vec2  uTexel;       // 1.0 / texture size
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uSaturation;
uniform float uTemperature;
uniform float uClarity;
uniform float uVignette;
uniform float uVibrance;
uniform float uCbCyanRed;
uniform float uCbMagentaGreen;
uniform float uCbYellowBlue;
uniform float uSplitHiHue;
uniform float uSplitLoHue;
uniform float uSplitAmount;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The two max(..., 0.0) calls below are NOT redundant:
//   mix(x, y, a) means x*(1-a) + y*a -- BOTH branches are always evaluated,
//   and GLSL leaves pow with a negative base undefined (in practice it
//   yields NaN). NaN * 0 is still NaN, so even the branch that ends up
//   discarded drags NaN into the result.
//
//   The base really can go negative: temperature +100 subtracts 0.1 from the
//   blue channel (negative in the darks), or clarity undershoots on a
//   high-contrast edge (base=0.1 / blur=0.5 -> -0.14).
//
//   tone.ts uses a ternary, so negative bases never reach pow there -- that
//   is a real behavioural difference between TS and GLSL, not just precision.
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

// Hue (0..1) -> a pure chroma tint (luma removed), so applying it shifts
// color without changing brightness.
vec3 hueTint(float h) {
  vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
  vec3 p = abs(fract(vec3(h) + k) * 6.0 - 3.0);
  vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
  return rgb - vec3(dot(rgb, LUMA));
}

void main() {
  vec2 uv = vUv;

  // 0. Clarity -- must come FIRST in the chain, operating on the raw texture.
  //
  //    Putting it later is wrong: c would already be exposure/contrast
  //    adjusted while blur still samples the raw pixels, so (c - blur) picks
  //    up a global brightness difference and moving the clarity slider would
  //    also brighten or darken the whole image. First in the chain, c - blur
  //    is identically 0 on flat areas and clarity only touches local detail.
  vec3 base = texture(uImage, uv).rgb;
  vec3 blur = (
      texture(uImage, uv + vec2(-uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2( uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2(0.0, -uTexel.y)).rgb
    + texture(uImage, uv + vec2(0.0,  uTexel.y)).rgb
  ) * 0.25;
  vec3 c = base + uClarity * 0.6 * (base - blur);

  // 1. Temperature
  c.r += uTemperature * 0.10;
  c.b -= uTemperature * 0.10;

  // 1.5 Color balance -- one shift per channel, same style as temperature.
  c.r += uCbCyanRed * 0.10;
  c.g += uCbMagentaGreen * 0.10;
  c.b += uCbYellowBlue * 0.10;

  // 2. Exposure (linear space)
  c = srgbToLinear(c);
  c *= pow(2.0, uExposure);
  c = linearToSrgb(c);

  // 3. Highlights / shadows -- weight by luma, then scale by the headroom
  //    each pixel has left. Must match tone.ts exactly.
  //
  //    The (1.0 - l) / l headroom factors are not decoration: without them
  //    highlights +100 pushes every pixel above luma ~0.79 past 1.0 and the
  //    final clamp flattens it (0.79 -> 1.0, 0.85 -> 1.0), destroying the
  //    highlight gradient -- bright sky / snow / beach is the archetypal
  //    travel photo; shadows -100 does the same at the dark end (luma below
  //    ~0.15 crushed to pure black).
  //
  //    Why the coefficient is exactly 1.0: gain = smoothstep(...) * C * (1-l),
  //    and smoothstep <= 1, so gain <= C * (1-l); with C = 1.0,
  //    l + gain <= l + (1-l) = 1 -- it can never cross the endpoint, i.e. it
  //    uses up exactly all the remaining headroom. C > 1 reintroduces
  //    clipping (at C = 2, 0.85 is back to 1.0); C too small makes the slider
  //    a no-op at full travel (C = 0.35 caps the gain at 0.045). At C = 1.0
  //    the peak gain is ~0.13 (near luma 0.79): visible, gradient intact.
  float l = dot(c, LUMA);
  float hiW = smoothstep(0.5, 1.0, l) * 1.0 * uHighlights * (1.0 - l);
  float loW = (1.0 - smoothstep(0.0, 0.5, l)) * 1.0 * uShadows * l;
  c += vec3(hiW + loW);

  // 4. Contrast (pivot at mid grey)
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // 5. Saturation
  float l2 = dot(c, LUMA);
  c = vec3(l2) + (c - vec3(l2)) * (1.0 + uSaturation);

  // 5.5 Vibrance -- push the DULL colors, leave the saturated ones alone
  //     (that is the whole difference from saturation).
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float satNow = mx > 1e-4 ? (mx - mn) / mx : 0.0;
  float l2b = dot(c, LUMA);
  c = vec3(l2b) + (c - vec3(l2b)) * (1.0 + uVibrance * (1.0 - satNow) * 1.2);

  // 6.5 Split toning -- tint highlights and shadows separately.
  //     At amount 0 this is an exact identity (adds vec3(0)).
  float l3 = dot(c, LUMA);
  float wHi = smoothstep(0.45, 1.0, l3);
  float wLo = 1.0 - smoothstep(0.0, 0.55, l3);
  c += hueTint(uSplitHiHue) * (wHi * uSplitAmount * 0.25);
  c += hueTint(uSplitLoHue) * (wLo * uSplitAmount * 0.25);

  // 6. Vignette
  //
  //    Only clamp the lower bound (max), not the upper one. A negative
  //    uVignette makes vig > 1 -- that is "brighten the corners". Clamping to
  //    1 here would kill the whole negative half of the slider (its range is
  //    -100~100, and a dead half makes users think it is broken).
  //    The final clamp(c, 0.0, 1.0) catches the overflow.
  vec2 d = uv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 3.5;
  c *= max(vig, 0.0);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`
