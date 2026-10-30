/**
 * 多参数调色，单个 fragment shader 一次算完（spec §5.2）。
 *
 * 调色链的顺序必须与 src/core/tone.ts 的 applyTone 严格一致——两者共有
 * 六个参数：色温 / 曝光 / 高光 / 阴影 / 对比度 / 饱和度。
 *
 * 清晰度、暗角和**磨皮**都**只有本文件有**：清晰度/磨皮需要邻域像素、
 * 暗角需要像素坐标，tone.ts 的单像素函数表达不了，没有可对照的实现。
 * （磨皮 ★ 2026-10-17 加的，见 main 里的 "0.5 Skin smoothing" 段。）
 *
 * 改任何一边都必须同步改另一边。**动这里的 GLSL 就必须跑 `scripts/check-lut.ts`**：
 * 同目录的 `shader.test.ts` 里只有**字符串级哨兵**（管线顺序 / 采样器精度限定 /
 * 不许有非 ASCII），而"编译得过不过、数值对不对"**只有那条真机探针看得见**
 * （真 Chrome + 真 GPU，要起 dev 服务器，`npm run check:lut`）。
 * 2026-10-05 抓到的那个 bug 就是这条规矩的来路：`uniform sampler3D uLut;`
 * 少了精度限定，ANGLE 下**整个 program 编译不过** —— 每一张照片都是黑画布，
 * 而单测 / typecheck / build / check:layout 四样全绿（它们对编译全都失明）。
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
uniform float uWhites;          // white-point lift / pull, -1..1 (0 = identity)
uniform float uBlacks;          // black-point lift / pull, -1..1 (0 = identity)
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;            // green-magenta tint, -1..1 (0 = identity)
uniform float uBwAmount;        // black-and-white mix, 0..1 (0 = identity)
uniform float uBwRed;           // per-channel monochrome mix weights, -1..1
uniform float uBwGreen;
uniform float uBwBlue;
uniform float uClarity;
uniform float uVignette;
uniform float uSkinSmooth;      // skin smoothing strength, 0..1 (0 = identity)
uniform float uDehaze;          // haze removal, -1..1 (0 = identity)
uniform float uHdr;             // local HDR tone mapping, 0..1 (0 = identity)
uniform float uGlow;            // soft halo around highlights, 0..1 (0 = identity)
uniform float uTexture;         // mid-frequency texture, -1..1 (0 = identity)
uniform float uSkinBrighten;    // skin brightening, 0..1 (0 = identity)
uniform float uSkinRosy;        // skin rosy tint, 0..1 (0 = identity)
uniform float uPerspectiveV;    // vertical keystone correction, -1..1
uniform float uPerspectiveH;    // horizontal keystone correction, -1..1
uniform float uLensBlur;        // radial lens blur strength, 0..1 (0 = identity)
uniform float uLensRange;       // sharp centre radius, -1..1 (0 = medium)
uniform float uLensFeather;     // focus falloff, -1..1 (0 = medium)
uniform float uLensFocusX;      // focus point, -1..1 (0 = centre)
uniform float uLensFocusY;
uniform float uLensShape;       // 0 = radial, 1 = tilt-shift band
uniform float uLensAngle;       // tilt band angle, -1..1 (= -90..90 deg)
uniform float uLensDistortion;  // radial distortion correction, -1..1 (0 = identity)
uniform float uLensChromatic;   // lateral chromatic aberration correction, -1..1
uniform float uLensVignette;    // lens vignetting correction, -1..1 (positive brightens corners)
uniform float uSharpen;         // edge sharpening strength, 0..1 (0 = identity)
uniform float uSharpenRadius;   // sharpening sample radius, 0..1 (0 = 1px)
uniform float uSharpenMasking;  // edge mask threshold, 0..1 (0 = no masking)
uniform float uNoiseReduction;  // edge-preserving denoise, 0..1 (0 = identity)
uniform float uColorNoiseReduction; // chroma-only denoise, 0..1 (0 = identity)
uniform float uGrain;           // film grain amount, 0..1 (0 = identity)
uniform float uHslOn;           // 1.0 when any HSL band is active
uniform float uHslRedHue;
uniform float uHslRedSat;
uniform float uHslRedLum;
uniform float uHslOrangeHue;
uniform float uHslOrangeSat;
uniform float uHslOrangeLum;
uniform float uHslYellowHue;
uniform float uHslYellowSat;
uniform float uHslYellowLum;
uniform float uHslGreenHue;
uniform float uHslGreenSat;
uniform float uHslGreenLum;
uniform float uHslCyanHue;
uniform float uHslCyanSat;
uniform float uHslCyanLum;
uniform float uHslBlueHue;
uniform float uHslBlueSat;
uniform float uHslBlueLum;
uniform float uHslPurpleHue;
uniform float uHslPurpleSat;
uniform float uHslPurpleLum;
uniform float uHslMagentaHue;
uniform float uHslMagentaSat;
uniform float uHslMagentaLum;
uniform float uCurveOn;         // 1.0 when any curve control point is active
uniform float uCurveBlack;
uniform float uCurveShadows;
uniform float uCurveMidtones;
uniform float uCurveHighlights;
uniform float uCurveWhite;
uniform float uCurveRgbOn;      // 1.0 when any RGB channel curve is active
uniform float uCurveRedBlack;
uniform float uCurveRedShadows;
uniform float uCurveRedMidtones;
uniform float uCurveRedHighlights;
uniform float uCurveRedWhite;
uniform float uCurveGreenBlack;
uniform float uCurveGreenShadows;
uniform float uCurveGreenMidtones;
uniform float uCurveGreenHighlights;
uniform float uCurveGreenWhite;
uniform float uCurveBlueBlack;
uniform float uCurveBlueShadows;
uniform float uCurveBlueMidtones;
uniform float uCurveBlueHighlights;
uniform float uCurveBlueWhite;
uniform float uVibrance;
uniform float uCbCyanRed;
uniform float uCbMagentaGreen;
uniform float uCbYellowBlue;
uniform float uSplitHiHue;
uniform float uSplitLoHue;
uniform float uSplitAmount;
uniform float uSplitMidHue;
uniform float uSplitMidAmount;
uniform float uSplitBalance;
uniform highp sampler3D uLut;   // the user's color lookup table (3D texture)
                                // NOTE: the precision qualifier is NOT optional --
                                // added 2026-10-05 after the real-GPU probe caught
                                // this program failing to compile ("'sampler3D' :
                                // No precision specified"). GLSL ES 3.00 declares a
                                // default precision for sampler2D / samplerCube
                                // only; every other sampler type must state its
                                // own. Without it the WHOLE program fails to link
                                // (not just the LUT block) -- every photo renders
                                // black and the user gets the generic render-failed
                                // notice instead of their picture.
uniform float uLutOn;           // 1.0 when a LUT is bound, 0.0 otherwise
uniform float uLutAmount;       // strength, 0..1
uniform vec3  uLutDomainMin;
uniform vec3  uLutDomainMax;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Skin mask shared by smoothing, brightening and the rosy tint.
// A soft Cb/Cr band plus a luma floor. The luma floor matters: brown hair
// sits almost exactly on the same Cb/Cr hue as skin, so without it the
// smoothing pass treats a dark fringe as "face" and turns it into mush.
float skinWeight(vec3 rgb) {
  vec3 rel = clamp(rgb, 0.0, 1.0);
  float cb = -0.168736 * rel.r - 0.331264 * rel.g + 0.5 * rel.b + 0.5;
  float cr = 0.5 * rel.r - 0.418688 * rel.g - 0.081312 * rel.b + 0.5;
  float skinCb = smoothstep(0.28, 0.34, cb) * (1.0 - smoothstep(0.48, 0.54, cb));
  float skinCr = smoothstep(0.50, 0.56, cr) * (1.0 - smoothstep(0.66, 0.72, cr));
  float skinY = smoothstep(0.14, 0.28, dot(rel, LUMA));
  return skinCb * skinCr * skinY;
}

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

// HSL hue distance on a circle (0..0.5).
float hueDist(float a, float b) {
  return abs(fract(a - b + 0.5) - 0.5);
}

// Soft membership of a pixel's hue in one of the eight color bands.
float hslWeight(float h, float center) {
  return 1.0 - smoothstep(0.0, 0.09, hueDist(h, center));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Five-point curve. The CPU twin is src/core/toneCurve.ts; keep the
// control-point math and the monotonic clamp in step. The master curve and
// the three per-channel curves share this function.
float curve5(float x, float p0, float p1, float p2, float p3, float p4) {
  float y0 = clamp(max(p0, 0.0) * 0.25, 0.0, 1.0);
  float y1 = clamp(0.25 + p1 * 0.25, 0.0, 1.0);
  float y2 = clamp(0.50 + p2 * 0.25, 0.0, 1.0);
  float y3 = clamp(0.75 + p3 * 0.25, 0.0, 1.0);
  float y4 = clamp(1.00 + min(p4, 0.0) * 0.25, 0.0, 1.0);
  y1 = max(y1, y0);
  y2 = max(y2, y1);
  y3 = max(y3, y2);
  y4 = max(y4, y3);
  if (x < 0.25) {
    float t = x / 0.25;
    return mix(y0, y1, t * t * (3.0 - 2.0 * t));
  }
  if (x < 0.50) {
    float t = (x - 0.25) / 0.25;
    return mix(y1, y2, t * t * (3.0 - 2.0 * t));
  }
  if (x < 0.75) {
    float t = (x - 0.50) / 0.25;
    return mix(y2, y3, t * t * (3.0 - 2.0 * t));
  }
  float t = (x - 0.75) / 0.25;
  return mix(y3, y4, t * t * (3.0 - 2.0 * t));
}

float curveAt(float x) {
  return curve5(x, uCurveBlack, uCurveShadows, uCurveMidtones, uCurveHighlights, uCurveWhite);
}
float curveRedAt(float x) {
  return curve5(x, uCurveRedBlack, uCurveRedShadows, uCurveRedMidtones, uCurveRedHighlights, uCurveRedWhite);
}
float curveGreenAt(float x) {
  return curve5(x, uCurveGreenBlack, uCurveGreenShadows, uCurveGreenMidtones, uCurveGreenHighlights, uCurveGreenWhite);
}
float curveBlueAt(float x) {
  return curve5(x, uCurveBlueBlack, uCurveBlueShadows, uCurveBlueMidtones, uCurveBlueHighlights, uCurveBlueWhite);
}

// Clamped texture tap for the detail filters. The default wrap mode is
// REPEAT; at the frame border that would pull pixels from the opposite edge
// into the denoise / sharpen neighborhood.
vec3 tapClamped(vec2 uv, vec2 offset) {
  return texture(uImage, clamp(uv + offset, 0.0, 1.0)).rgb;
}

// Perspective correction (2026-10-17).
//
// Output UV -> source UV is a true projective map around the image centre:
//   src = q / (1 + V*q.y + H*q.x)
// The four output corners are checked and a uniform zoom is applied until
// they all land inside [0,1], so the warp never leaves blank borders.
// This is a sampling-grid transform: every color operation still runs on the
// warped source pixel, and vUv is kept for output-space effects (vignette).
vec2 perspectivePoint(vec2 p, float zoom) {
  vec2 q = (p - 0.5) * zoom;
  float den = 1.0 + (uPerspectiveV * q.y + uPerspectiveH * q.x) * 1.1;
  return q / max(den, 0.25);
}

float perspectiveMax(float zoom) {
  vec2 a = perspectivePoint(vec2(0.0, 0.0), zoom);
  vec2 b = perspectivePoint(vec2(1.0, 0.0), zoom);
  vec2 c = perspectivePoint(vec2(0.0, 1.0), zoom);
  vec2 d = perspectivePoint(vec2(1.0, 1.0), zoom);
  float m = max(max(abs(a.x), abs(a.y)), max(abs(b.x), abs(b.y)));
  return max(m, max(max(abs(c.x), abs(c.y)), max(abs(d.x), abs(d.y))));
}

vec2 perspectiveUv(vec2 p) {
  if (abs(uPerspectiveV) + abs(uPerspectiveH) < 1e-5) return p;
  float zoom = 1.0;
  for (int i = 0; i < 3; i++) {
    float m = perspectiveMax(zoom);
    zoom = min(zoom, zoom * 0.5 / max(m, 1e-4));
  }
  return perspectivePoint(p, zoom) + 0.5;
}

// Lens distortion correction (2026-10-17).
//
// A quadratic radial mapping around the image centre. Positive values pull
// the outer samples from farther out (barrel correction); negative values do
// the opposite. The uniform zoom is solved for the four corners first, so a
// positive correction never exposes blank borders. At zero this function
// returns p unchanged, keeping every previously saved render identical.
vec2 lensPoint(vec2 p, float zoom) {
  vec2 q = (p - 0.5) * zoom;
  float r2 = dot(q, q);
  return q * (1.0 + uLensDistortion * 0.35 * r2);
}

float lensMax(float zoom) {
  vec2 a = lensPoint(vec2(0.0, 0.0), zoom);
  vec2 b = lensPoint(vec2(1.0, 0.0), zoom);
  vec2 c = lensPoint(vec2(0.0, 1.0), zoom);
  vec2 d = lensPoint(vec2(1.0, 1.0), zoom);
  float m = max(max(abs(a.x), abs(a.y)), max(abs(b.x), abs(b.y)));
  return max(m, max(max(abs(c.x), abs(c.y)), max(abs(d.x), abs(d.y))));
}

vec2 lensUv(vec2 p) {
  if (abs(uLensDistortion) < 1e-5) return p;
  float zoom = 1.0;
  for (int i = 0; i < 4; i++) {
    float m = lensMax(zoom);
    zoom = min(zoom, zoom * 0.5 / max(m, 1e-4));
  }
  return lensPoint(p, zoom) + 0.5;
}

void main() {
  vec2 uv = clamp(lensUv(perspectiveUv(vUv)), 0.0, 1.0);

  // 0. Clarity -- must come FIRST in the chain, operating on the raw texture.
  //
  //    Putting it later is wrong: c would already be exposure/contrast
  //    adjusted while blur still samples the raw pixels, so (c - blur) picks
  //    up a global brightness difference and moving the clarity slider would
  //    also brighten or darken the whole image. First in the chain, c - blur
  //    is identically 0 on flat areas and clarity only touches local detail.
  vec4 baseTexel = texture(uImage, uv);
  // 2026-10-17 (transparent cutout): the color chain only changes RGB.
  // Keep source alpha untouched so erased pixels stay transparent.
  float sourceAlpha = baseTexel.a;
  // Lateral chromatic aberration correction: move red and blue in opposite
  // radial directions while green stays put. At zero this branch is skipped
  // and the result is the same single texture tap as before.
  if (abs(uLensChromatic) > 1e-5) {
    vec2 cq = uv - 0.5;
    float cr2 = dot(cq, cq);
    vec2 shift = cq * uLensChromatic * cr2 * 0.04;
    baseTexel.r = texture(uImage, clamp(uv + shift, 0.0, 1.0)).r;
    baseTexel.b = texture(uImage, clamp(uv - shift, 0.0, 1.0)).b;
  }
  // Lens vignetting correction (2026-10-20): physical falloff happens at
  // capture time, so correct it before the tone chain. Positive lifts the
  // corners (removes a dark vignette), negative deepens it. The radius is
  // normalized by the corner distance so the slider means the same thing on
  // any aspect ratio.
  if (abs(uLensVignette) > 1e-5) {
    float aspect = uTexel.y / uTexel.x;
    vec2 vp = uv - 0.5;
    vp.x *= aspect;
    float corner = 0.5 * sqrt(aspect * aspect + 1.0);
    float fall = smoothstep(0.35, 1.0, length(vp) / max(corner, 1e-4));
    baseTexel.rgb *= 1.0 + uLensVignette * fall * 0.65;
  }
  vec3 base = baseTexel.rgb;
  vec3 blur = (
      texture(uImage, uv + vec2(-uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2( uTexel.x, 0.0)).rgb
    + texture(uImage, uv + vec2(0.0, -uTexel.y)).rgb
    + texture(uImage, uv + vec2(0.0,  uTexel.y)).rgb
  ) * 0.25;
  vec3 c = base + uClarity * 0.6 * (base - blur);

  // 0.4 Skin mask -- shared by smoothing, brightening and rosy tint.
  //     A soft Cb/Cr band plus a luma floor (see skinWeight above): dark
  //     skin gets partial weight, while brown hair falls below the floor.
  float skin = 0.0;
  if (uSkinSmooth > 0.0 || uSkinBrighten > 0.0 || uSkinRosy > 0.0) {
    skin = skinWeight(base);
  }

  // 0.5 Skin smoothing (2026-10-17) -- edge-preserving, skin-tone gated.
  //
  //     Runs on the RAW texture like clarity (step 0): c and every sample
  //     here are pre-color-adjustment, so the mix below is an exact identity
  //     when uSkinSmooth is 0, and the tone chain afterwards applies to the
  //     smoothed color uniformly.
  //
  //     Two parts:
  //       (a) the shared skin mask above (Cb/Cr, conservative);
  //       (b) a 12-tap bilateral-ish average: two rings of six samples,
  //           weighted by luma difference to the center pixel, so eyes, brows
  //           and hair edges (high contrast) stay sharp while pores (low
  //           contrast) get averaged away. The radius scales with the image
  //           short side, so the slider means the same thing at 2 MP and at
  //           24 MP.
  //
  //     Uniform branch: when uSkinSmooth is 0 the block is skipped entirely
  //     (every fragment takes the same branch), so the tap cost only appears
  //     while the slider is actually in use.
  if (uSkinSmooth > 0.0) {
    // Short side in pixels (uTexel = 1.0 / texture size).
    float shortSide = 1.0 / max(uTexel.x, uTexel.y);
    float radius = clamp(shortSide * 0.003, 1.0, 10.0);
    float l0 = dot(base, LUMA);
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    // Edge guard: the largest luma difference inside the two rings. Pores
    // move a few grey levels; a lash, hair strand or lip edge moves tens.
    float maxDiff = 0.0;
    for (int i = 0; i < 12; i++) {
      float ang = float(i % 6) * 1.0471976;   // 6 directions, 60 deg apart
      float ring = i < 6 ? 1.0 : 1.8;         // inner / outer ring
      vec2 off = vec2(cos(ang), sin(ang)) * (radius * ring);
      vec3 s = texture(uImage, uv + off * uTexel).rgb;
      float ds = dot(s, LUMA) - l0;
      maxDiff = max(maxDiff, abs(ds));
      float dl = ds * 25.0;
      // Only skin-looking samples vote. Hair is the classic false positive
      // in the Cb/Cr band, so its samples keep just a 12% voice instead of
      // dragging a dark average into the cheek.
      float sampleSkin = skinWeight(s);
      float w = (1.0 / (1.0 + dl * dl)) * (0.12 + 0.88 * sampleSkin);
      sum += s * w;
      wsum += w;
    }
    vec3 soft = sum / max(wsum, 1e-4);
    float edge = smoothstep(0.055, 0.20, maxDiff);
    // 0.9 leaves one tenth of the original texture in place -- without it a
    // maxed-out slider reads as the plastic "beauty camera" face.
    // The edge term takes another 85% off at lashes / brows / lip borders.
    float amount = uSkinSmooth * skin * 0.9 * (1.0 - 0.85 * edge);
    c = mix(c, soft, amount);
  }

  // 0.55 Texture -- a wider unsharp pass than clarity / sharpen. Positive
  //      values bring back mid-frequency surface detail; negative values
  //      soften it without turning the image into plastic. At 0 this block
  //      is skipped, so older renders stay byte-identical.
  if (abs(uTexture) > 1e-5) {
    vec2 tx = uTexel * 2.0;
    vec3 texBlur = (
        tapClamped(uv, vec2(-tx.x, 0.0))
      + tapClamped(uv, vec2( tx.x, 0.0))
      + tapClamped(uv, vec2(0.0, -tx.y))
      + tapClamped(uv, vec2(0.0,  tx.y))
    ) * 0.25;
    c += (base - texBlur) * uTexture * 0.55;
  }

  // 0.6 Detail -- noise reduction and sharpening (2026-10-17).
  //
  //     Both operate on the raw texture, like clarity and skin smoothing.
  //     Denoise is a small bilateral average: neighbors whose luma differs a
  //     lot get almost no weight, so edges stay put while fine noise averages
  //     away. Sharpen is an unsharp mask against the raw 4-neighbor blur.
  //     Each block is a uniform branch; at 0 the slider is an exact identity.
  if (uNoiseReduction > 0.0) {
    float nrL = dot(base, LUMA);
    vec3 nr = base;
    float nrW = 1.0;
    vec2 no = uTexel * 1.5;
    vec3 n0 = tapClamped(uv, vec2( no.x, 0.0));
    vec3 n1 = tapClamped(uv, vec2(-no.x, 0.0));
    vec3 n2 = tapClamped(uv, vec2(0.0,  no.y));
    vec3 n3 = tapClamped(uv, vec2(0.0, -no.y));
    vec3 n4 = tapClamped(uv, vec2( no.x,  no.y));
    vec3 n5 = tapClamped(uv, vec2(-no.x,  no.y));
    vec3 n6 = tapClamped(uv, vec2( no.x, -no.y));
    vec3 n7 = tapClamped(uv, vec2(-no.x, -no.y));
    float d0 = (dot(n0, LUMA) - nrL) * 18.0;
    float d1 = (dot(n1, LUMA) - nrL) * 18.0;
    float d2 = (dot(n2, LUMA) - nrL) * 18.0;
    float d3 = (dot(n3, LUMA) - nrL) * 18.0;
    float d4 = (dot(n4, LUMA) - nrL) * 18.0;
    float d5 = (dot(n5, LUMA) - nrL) * 18.0;
    float d6 = (dot(n6, LUMA) - nrL) * 18.0;
    float d7 = (dot(n7, LUMA) - nrL) * 18.0;
    float w0 = 1.0 / (1.0 + d0 * d0);
    float w1 = 1.0 / (1.0 + d1 * d1);
    float w2 = 1.0 / (1.0 + d2 * d2);
    float w3 = 1.0 / (1.0 + d3 * d3);
    float w4 = 1.0 / (1.0 + d4 * d4);
    float w5 = 1.0 / (1.0 + d5 * d5);
    float w6 = 1.0 / (1.0 + d6 * d6);
    float w7 = 1.0 / (1.0 + d7 * d7);
    nr += n0 * w0 + n1 * w1 + n2 * w2 + n3 * w3
        + n4 * w4 + n5 * w5 + n6 * w6 + n7 * w7;
    nrW += w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7;
    c = mix(c, nr / nrW, uNoiseReduction * 0.8);
  }
  // Chroma-only denoise: average neighbouring colours while keeping the
  // current pixel's luma. Luma differences gate the taps so clean edges and
  // fine monochrome texture do not turn into colour bleed.
  if (uColorNoiseReduction > 0.0) {
    float baseY = dot(base, LUMA);
    vec3 baseChroma = base - baseY;
    vec3 chromaSum = baseChroma;
    float chromaW = 1.0;
    vec2 co = uTexel * 2.2;
    vec3 q0 = tapClamped(uv, vec2( co.x, 0.0));
    vec3 q1 = tapClamped(uv, vec2(-co.x, 0.0));
    vec3 q2 = tapClamped(uv, vec2(0.0,  co.y));
    vec3 q3 = tapClamped(uv, vec2(0.0, -co.y));
    vec3 q4 = tapClamped(uv, vec2( co.x,  co.y));
    vec3 q5 = tapClamped(uv, vec2(-co.x,  co.y));
    vec3 q6 = tapClamped(uv, vec2( co.x, -co.y));
    vec3 q7 = tapClamped(uv, vec2(-co.x, -co.y));
    float q0d = dot(q0, LUMA) - baseY;
    float q1d = dot(q1, LUMA) - baseY;
    float q2d = dot(q2, LUMA) - baseY;
    float q3d = dot(q3, LUMA) - baseY;
    float q4d = dot(q4, LUMA) - baseY;
    float q5d = dot(q5, LUMA) - baseY;
    float q6d = dot(q6, LUMA) - baseY;
    float q7d = dot(q7, LUMA) - baseY;
    float q0w = 1.0 / (1.0 + q0d * q0d * 12.0);
    float q1w = 1.0 / (1.0 + q1d * q1d * 12.0);
    float q2w = 1.0 / (1.0 + q2d * q2d * 12.0);
    float q3w = 1.0 / (1.0 + q3d * q3d * 12.0);
    float q4w = 1.0 / (1.0 + q4d * q4d * 12.0);
    float q5w = 1.0 / (1.0 + q5d * q5d * 12.0);
    float q6w = 1.0 / (1.0 + q6d * q6d * 12.0);
    float q7w = 1.0 / (1.0 + q7d * q7d * 12.0);
    chromaSum += (q0 - dot(q0, LUMA)) * q0w;
    chromaSum += (q1 - dot(q1, LUMA)) * q1w;
    chromaSum += (q2 - dot(q2, LUMA)) * q2w;
    chromaSum += (q3 - dot(q3, LUMA)) * q3w;
    chromaSum += (q4 - dot(q4, LUMA)) * q4w;
    chromaSum += (q5 - dot(q5, LUMA)) * q5w;
    chromaSum += (q6 - dot(q6, LUMA)) * q6w;
    chromaSum += (q7 - dot(q7, LUMA)) * q7w;
    chromaW += q0w + q1w + q2w + q3w + q4w + q5w + q6w + q7w;
    vec3 blurChroma = chromaSum / chromaW;
    c += (blurChroma - baseChroma) * uColorNoiseReduction;
  }
  if (uSharpen > 0.0) {
    vec2 so = uTexel * (1.0 + uSharpenRadius * 2.5);
    vec3 sharpBlur = (
        tapClamped(uv, vec2(-so.x, 0.0))
      + tapClamped(uv, vec2( so.x, 0.0))
      + tapClamped(uv, vec2(0.0, -so.y))
      + tapClamped(uv, vec2(0.0,  so.y))
    ) * 0.25;
    vec3 detail = base - sharpBlur;
    float sharpGate = smoothstep(
      0.0, max(1e-4, uSharpenMasking * 0.45), length(detail) * 4.0);
    c += (base - sharpBlur) * uSharpen * 1.1 * sharpGate;
  }
  // 0.7 Lens blur -- radial depth-of-field or tilt-shift band (2026-10-17).
  //
  //     The focus point comes from uLensFocusX/Y (0 = centre, -1..1 = edge).
  //     vUv (output space) decides the mask, so perspective correction does
  //     not bend the focus circle.
  //     A 20-tap golden-angle disk gives a smoother falloff than a square
  //     kernel; the radius scales with the short side, so it looks the same
  //     on a 2 MP and a 24 MP photo. This is a creative lens effect, not an
  //     AI subject cutout.
  if (uLensBlur > 0.0) {
    float aspect = uTexel.y / max(uTexel.x, 1e-6);
    float focus;
    if (uLensShape > 0.5) {
      // Tilt-shift: a straight clear band across the frame. The handle only
      // moves the band vertically; focusX stays untouched when switching back.
      float bandAngle = uLensAngle * 1.5707963;
      vec2 bandCenter = vec2(
        0.5, clamp(0.5 + uLensFocusY * 0.5, 0.0, 1.0));
      vec2 bandQ = (vUv - bandCenter) * vec2(aspect, 1.0);
      vec2 bandNormal = vec2(-sin(bandAngle), cos(bandAngle));
      float bandDistance = abs(dot(bandQ, bandNormal));
      float bandHalf = mix(0.08, 0.50, uLensRange * 0.5 + 0.5);
      float bandFeather = mix(0.03, 0.20, uLensFeather * 0.5 + 0.5);
      focus = smoothstep(bandHalf, bandHalf + bandFeather, bandDistance);
    } else {
      vec2 focusCenter = clamp(
        vec2(0.5) + vec2(uLensFocusX, uLensFocusY) * 0.5, 0.0, 1.0);
      vec2 q = (vUv - focusCenter) * vec2(aspect, 1.0) * 2.0;
      float r = length(q);
      float focusRadius = mix(0.22, 0.70, uLensRange * 0.5 + 0.5);
      float feather = mix(0.04, 0.30, uLensFeather * 0.5 + 0.5);
      focus = smoothstep(focusRadius, focusRadius + feather, r);
    }
    float shortSide = 1.0 / max(uTexel.x, uTexel.y);
    float blurPx = clamp(shortSide * 0.01 * uLensBlur, 1.0, 30.0);
    vec3 bokeh = vec3(0.0);
    for (int i = 0; i < 20; i++) {
      float t = (float(i) + 0.5) / 20.0;
      float ang = float(i) * 2.39996323;
      float rr = sqrt(t) * blurPx;
      bokeh += tapClamped(uv, vec2(cos(ang), sin(ang)) * rr * uTexel);
    }
    bokeh /= 20.0;
    c = mix(c, bokeh, uLensBlur * focus);
  }

  // 0.8 HDR -- local tone mapping (2026-10-18).
  //
  //     Lifts locally dark areas, compresses locally bright areas and adds
  //     a little local contrast. The local level comes from the raw texture's
  //     4-neighbour blur, like clarity, so the lift/compress decision follows
  //     the actual scene rather than the already-adjusted color. At 0 the
  //     block is skipped and every previously saved render is unchanged.
  if (uHdr > 0.0) {
    float l = dot(c, LUMA);
    float local = dot(blur, LUMA);
    float lift = uHdr * (1.0 - smoothstep(0.0, 0.45, local)) * 0.18;
    float comp = uHdr * smoothstep(0.55, 1.0, local) * 0.18;
    c += vec3(lift * (1.0 - l) - comp * l);
    c += (c - blur) * uHdr * 0.35;
    float hl = dot(c, LUMA);
    c = vec3(hl) + (c - vec3(hl)) * (1.0 + uHdr * 0.12);
  }

  // 0.9 Glow -- soft halo around bright areas (2026-10-18).
  //
  //     Eight taps at two radii give a wider, softer halo than the 4-neighbour
  //     blur used by clarity. The halo is gated by its own brightness, so a
  //     bright lamp blooms while a mid-grey wall stays put. Screen blending
  //     keeps the centre from turning muddy. At 0 the block is skipped.
  if (uGlow > 0.0) {
    float shortSide = 1.0 / max(uTexel.x, uTexel.y);
    float radius = clamp(shortSide * 0.02, 3.0, 24.0);
    vec2 g1 = uTexel * radius;
    vec2 g2 = uTexel * radius * 2.0;
    vec3 t0 = tapClamped(uv, vec2(-g1.x, 0.0));
    vec3 t1 = tapClamped(uv, vec2( g1.x, 0.0));
    vec3 t2 = tapClamped(uv, vec2(0.0, -g1.y));
    vec3 t3 = tapClamped(uv, vec2(0.0,  g1.y));
    vec3 t4 = tapClamped(uv, vec2(-g2.x, -g2.y));
    vec3 t5 = tapClamped(uv, vec2( g2.x, -g2.y));
    vec3 t6 = tapClamped(uv, vec2(-g2.x,  g2.y));
    vec3 t7 = tapClamped(uv, vec2( g2.x,  g2.y));
    vec3 avg = (t0 + t1 + t2 + t3 + t4 + t5 + t6 + t7) / 8.0;
    vec3 hmax = max(max(max(t0, t1), max(t2, t3)), max(max(t4, t5), max(t6, t7)));
    // Average alone is diluted when only one or two of the eight taps hit a
    // small light source. Half of the max keeps that source's halo alive.
    vec3 halo = mix(avg, hmax, 0.5);
    float gate = smoothstep(0.35, 0.85, dot(halo, LUMA));
    vec3 bloom = max(halo - vec3(0.30), vec3(0.0)) * uGlow * gate * 0.9;
    c = 1.0 - (1.0 - c) * (1.0 - bloom);
  }

  // 1. Temperature
  c.r += uTemperature * 0.10;
  c.b -= uTemperature * 0.10;
  // 1.5 Tint -- the green-magenta axis. Positive adds magenta, negative adds
  //     green. The coefficients are luminance-balanced so tint does not double
  //     as an exposure control.
  c.r += uTint * 0.09;
  c.g -= uTint * 0.035;
  c.b += uTint * 0.09;

  // 1.6 Color balance -- one shift per channel, same style as temperature.
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

  // 3.5 Whites / blacks -- endpoint-weighted tone controls. A small floor
  //     keeps the very ends movable (pure black can be lifted, pure white can
  //     be pulled) without letting the sliders act like a second exposure.
  float lw = dot(c, LUMA);
  float whiteW = smoothstep(0.65, 1.0, lw) * uWhites
    * (0.05 + 0.95 * (1.0 - lw)) * 1.2;
  float blackW = (1.0 - smoothstep(0.0, 0.35, lw)) * uBlacks
    * (0.05 + 0.95 * lw) * 1.2;
  c += vec3(whiteW + blackW);

  // 4. Contrast (pivot at mid grey)
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // 4.5 Dehaze (2026-10-17) -- local dark-channel stretch.
  //
  //     The haze estimate comes from the raw texture's local dark channel
  //     (min over RGB and four neighbours), so earlier tone sliders do not
  //     move the estimate. Positive values divide the low-contrast bright
  //     veil away and restore a little saturation; negative values mix in a
  //     cool atmospheric wash. The branch is skipped at 0, keeping every
  //     existing render byte-identical.
  if (abs(uDehaze) > 1e-5) {
    vec3 dc = min(base, tapClamped(uv, vec2(-uTexel.x, 0.0)));
    dc = min(dc, tapClamped(uv, vec2(uTexel.x, 0.0)));
    dc = min(dc, tapClamped(uv, vec2(0.0, -uTexel.y)));
    dc = min(dc, tapClamped(uv, vec2(0.0, uTexel.y)));
    float dark = min(min(dc.r, dc.g), dc.b);
    float haze = smoothstep(0.30, 0.85, dark);
    if (uDehaze > 0.0) {
      float trans = 1.0 - uDehaze * 0.45 * haze;
      c = (c - vec3(0.05 * uDehaze * haze)) / max(trans, 0.35);
      float dl = dot(c, LUMA);
      c = vec3(dl) + (c - vec3(dl)) * (1.0 + uDehaze * 0.22 * haze);
    } else {
      c = mix(c, vec3(0.82, 0.86, 0.92), (-uDehaze) * 0.35);
    }
  }

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

  // 5.8 HSL bands -- hue / saturation / luminance for eight color ranges.
  //     The eight bands overlap slightly; normalize by the weight sum so a
  //     color sitting between two centers does not get a double dose.
  //     uHslOn == 0 skips the HSV round trip entirely (exact identity).
  if (uHslOn > 0.0) {
    vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
    float h = hsv.x;
    float wsum = 0.0;
    float hueShift = 0.0;
    float satShift = 0.0;
    float lumShift = 0.0;
    float w;

    w = hslWeight(h, 0.0);           wsum += w;
    hueShift += w * uHslRedHue;      satShift += w * uHslRedSat;      lumShift += w * uHslRedLum;
    w = hslWeight(h, 1.0 / 12.0);    wsum += w;
    hueShift += w * uHslOrangeHue;   satShift += w * uHslOrangeSat;   lumShift += w * uHslOrangeLum;
    w = hslWeight(h, 1.0 / 6.0);     wsum += w;
    hueShift += w * uHslYellowHue;   satShift += w * uHslYellowSat;   lumShift += w * uHslYellowLum;
    w = hslWeight(h, 1.0 / 3.0);     wsum += w;
    hueShift += w * uHslGreenHue;    satShift += w * uHslGreenSat;    lumShift += w * uHslGreenLum;
    w = hslWeight(h, 0.5);           wsum += w;
    hueShift += w * uHslCyanHue;     satShift += w * uHslCyanSat;     lumShift += w * uHslCyanLum;
    w = hslWeight(h, 2.0 / 3.0);     wsum += w;
    hueShift += w * uHslBlueHue;     satShift += w * uHslBlueSat;     lumShift += w * uHslBlueLum;
    w = hslWeight(h, 7.0 / 9.0);     wsum += w;
    hueShift += w * uHslPurpleHue;   satShift += w * uHslPurpleSat;   lumShift += w * uHslPurpleLum;
    w = hslWeight(h, 8.0 / 9.0);     wsum += w;
    hueShift += w * uHslMagentaHue;  satShift += w * uHslMagentaSat;  lumShift += w * uHslMagentaLum;

    float norm = max(wsum, 1e-4);
    hsv.x = fract(hsv.x + (hueShift / norm) * 0.1666667);
    hsv.y = clamp(hsv.y + (satShift / norm) * 0.5, 0.0, 1.0);
    hsv.z = clamp(hsv.z + (lumShift / norm) * 0.35, 0.0, 1.0);
    c = hsv2rgb(hsv);
  }

  // 5.85 Black-and-white mix -- channel weights scale the standard Rec.709
  //      luminance weights by 2^amount, then normalize. At zero this branch is
  //      skipped; at 100 the result is a true grayscale image.
  if (uBwAmount > 1e-5) {
    vec3 bwWeights = vec3(0.2126, 0.7152, 0.0722)
      * pow(vec3(2.0), vec3(uBwRed, uBwGreen, uBwBlue));
    bwWeights /= max(dot(bwWeights, vec3(1.0)), 1e-6);
    float bw = dot(c, bwWeights);
    c = mix(c, vec3(bw), uBwAmount);
  }

  // 5.9 Luminance curve -- five control points, applied as a luma offset
  //     so hue/saturation relationships survive the tonal change.
  if (uCurveOn > 0.0) {
    float curveL = clamp(dot(c, LUMA), 0.0, 1.0);
    c += vec3(curveAt(curveL) - curveL);
  }

  // 5.92 RGB channel curves -- master curve stays first, then per-channel
  //      curves correct color / cross-channel response. At 0 the whole block
  //      is skipped, so existing photos are byte-identical.
  if (uCurveRgbOn > 0.0) {
    c.r = curveRedAt(clamp(c.r, 0.0, 1.0));
    c.g = curveGreenAt(clamp(c.g, 0.0, 1.0));
    c.b = curveBlueAt(clamp(c.b, 0.0, 1.0));
  }

  // 5.95 Skin beauty -- brighten and warm the skin only. The shared skin
  //      mask keeps background and clothing untouched; at 0 both fields
  //      are an exact identity.
  if (uSkinBrighten > 0.0 || uSkinRosy > 0.0) {
    vec3 beautified = c * (1.0 + uSkinBrighten * 0.35);
    beautified += vec3(0.10, 0.02, -0.04) * uSkinRosy;
    c = mix(c, beautified, skin);
  }

  // 6.5 Color grading -- tint shadows, midtones and highlights separately.
  //     uSplitBalance shifts which tonal range receives more weight;
  //     at both amounts 0 this is an exact identity (adds vec3(0)).
  float l3 = dot(c, LUMA);
  float toneL = clamp(l3 + uSplitBalance * 0.12, 0.0, 1.0);
  float wHi = smoothstep(0.45, 1.0, toneL);
  float wLo = 1.0 - smoothstep(0.0, 0.55, toneL);
  float wMid = 1.0 - abs(toneL * 2.0 - 1.0);
  c += hueTint(uSplitHiHue) * (wHi * uSplitAmount * 0.25);
  c += hueTint(uSplitLoHue) * (wLo * uSplitAmount * 0.25);
  c += hueTint(uSplitMidHue) * (wMid * uSplitMidAmount * 0.25);

  // 6. Vignette
  //
  //    Only clamp the lower bound (max), not the upper one. A negative
  //    uVignette makes vig > 1 -- that is "brighten the corners". Clamping to
  //    1 here would kill the whole negative half of the slider (its range is
  //    -100~100, and a dead half makes users think it is broken).
  //    The final clamp(c, 0.0, 1.0) catches the overflow.
  vec2 d = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 3.5;
  c *= max(vig, 0.0);

  // 7.5 Film grain -- deterministic per-pixel noise. It sits before the LUT
  //     because the LUT is always the last step in the chain (section 7).
  if (uGrain > 0.0) {
    float gn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    c += vec3((gn - 0.5) * uGrain * 0.12);
  }

  // 7. LUT (color lookup) -- ALWAYS THE LAST STEP. This is a contract, not a
  //    preference (see the design doc 2026-10-05 section 4.1): every saved work was
  //    rendered through this order, so moving the LUT earlier would change the
  //    colors of every existing photo. Do not reorder.
  //
  //    uLutOn is 0 when nothing is bound, which makes lutAmt 0 and the whole
  //    block an exact identity -- strength 0 must be pixel-for-pixel identical
  //    to having no LUT at all.
  //
  //    The half-texel correction is NOT optional: a .cube entry i stands for
  //    the input i/(n-1), while GL puts texel i's center at (i+0.5)/n. Handing
  //    the normalized value straight to texture() shifts every lookup by up to
  //    half a texel (an n=2 table turns input 0.25 into pure black). The CPU
  //    twin (src/core/lut.ts) samples in endpoint-inclusive index space, and it
  //    is what the acceptance probe compares against -- the two must agree.
  float lutAmt = uLutOn * uLutAmount;
  if (lutAmt > 0.0) {
    vec3 q = clamp(c, 0.0, 1.0);
    vec3 t = clamp((q - uLutDomainMin) / max(uLutDomainMax - uLutDomainMin, vec3(1e-6)),
                   vec3(0.0), vec3(1.0));
    float n = float(textureSize(uLut, 0).x);
    vec3 u = (t * (n - 1.0) + 0.5) / n;
    c = mix(q, texture(uLut, u).rgb, lutAmt);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), sourceAlpha);
}
`
