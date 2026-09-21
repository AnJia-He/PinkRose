"""SPIKE 第三轮 —— 量化「构图漂移」。
用程序量三件事，而不是靠肉眼：
  1. 地平线位置漂移多少（原图 78%）
  2. 背景两个人有没有被去掉（该区域的深色像素数）
  3. 天空有没有变蓝（顶部平均色）
连打 3 次，看结果稳不稳（可复现性）。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import sys
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPIKE = Path(__file__).resolve().parent


def load_env() -> dict[str, str]:
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def to_data_url(p: Path) -> str:
    mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def edit(base, key, model, image: Path, prompt: str, size=None, timeout=300):
    payload = {"model": model, "images": [{"image_url": to_data_url(image)}],
               "prompt": prompt, "n": 1, "size": size or "auto",
               "watermark": False, "prompt_extend": True, "response_format": "url"}
    for attempt in (1, 2, 3):
        try:
            r = requests.post(f"{base}/images/edits", json=payload,
                              headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
            break
        except Exception as e:
            if attempt == 3:
                return {"ok": False, "detail": f"{type(e).__name__}: {e}"}
            print(f"      (retry {attempt}: {type(e).__name__})")
    if r.status_code != 200:
        return {"ok": False, "detail": f"HTTP {r.status_code}: {r.text[:300]}"}
    d = r.json()
    urls = d.get("images_urls") or []
    if not urls:
        urls = [u.get("url") or u.get("image_url") for u in (d.get("data") or [])
                if isinstance(u, dict)]
    urls = [u for u in urls if u]
    if not urls:
        return {"ok": False, "detail": json.dumps(d)[:300]}
    return {"ok": True, "url": urls[-1], "size": d.get("size")}


def grab(url, dest: Path) -> bool:
    for attempt in (1, 2, 3):
        try:
            r = requests.get(url, timeout=180)
            r.raise_for_status()
            dest.write_bytes(r.content)
            return True
        except Exception:
            if attempt == 3:
                return False
    return False


# ---------- 量化指标 ----------
def horizon_pct(im: Image.Image) -> float:
    """找下半部分最明显的水平色变位置，返回占画面高度百分比。"""
    im = im.convert("RGB").resize((160, 120))
    px = im.load()
    best, best_y = -1.0, -1
    for y in range(50, 115):
        diff = sum(abs(px[x, y][i] - px[x, y - 4][i]) for x in range(0, 160, 4) for i in range(3))
        if diff > best:
            best, best_y = diff, y
    return round(100 * best_y / 120, 1)


def sky_top(im: Image.Image) -> tuple[int, int, int]:
    im = im.convert("RGB").resize((160, 120))
    px = im.load()
    n = 0
    r = g = b = 0
    for y in range(0, 20):
        for x in range(0, 160, 2):
            p = px[x, y]
            r += p[0]; g += p[1]; b += p[2]; n += 1
    return (r // n, g // n, b // n)


def dark_pixels(im: Image.Image, x0f, x1f, y0f, y1f) -> int:
    """统计指定矩形区域内「深色」像素数（用来找人）。"""
    im = im.convert("RGB")
    W, H = im.size
    box = im.crop((int(x0f * W), int(y0f * H), int(x1f * W), int(y1f * H)))
    px = box.load()
    c = 0
    for y in range(box.height):
        for x in range(box.width):
            r, g, b = px[x, y]
            if r + g + b < 260:
                c += 1
    return c


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    src = SPIKE / "input_scene.jpg"

    with Image.open(src) as im0:
        print(f"【原图基准】 尺寸={im0.width}x{im0.height}  "
              f"地平线={horizon_pct(im0)}%  天空={sky_top(im0)}  "
              f"人物区深色像素={dark_pixels(im0, 0.70, 0.85, 0.70, 0.88)}")

    prompt = ("Make the sky a clear vivid blue. Remove the two people standing "
              "in the background. Preserve the mountains, ground, lighting, and framing.")

    print(f"\n【锁死尺寸 1024x768（=原图尺寸），连打 3 次】")
    for i in range(1, 4):
        print(f"  --- 第 {i} 次 ---")
        r = edit(base, key, "sensenova-u1.5-fast", src, prompt, size="1024x768")
        if not r["ok"]:
            print(f"    FAILED {r['detail'][:200]}")
            continue
        dest = SPIKE / f"fixed_{i}.png"
        if not grab(r["url"], dest):
            print("    download failed"); continue
        with Image.open(dest) as im:
            print(f"    输出={im.width}x{im.height}  resp.size={r['size']}  "
                  f"地平线={horizon_pct(im)}%  天空={sky_top(im)}  "
                  f"人物区深色像素={dark_pixels(im, 0.70, 0.85, 0.70, 0.88)}")


if __name__ == "__main__":
    main()
