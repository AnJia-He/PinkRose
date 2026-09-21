"""SPIKE 第四轮 —— 【最关键】真人脸保真度测试。
三个场景，都是旅游打卡党最常说的话：
  A 调色类：「亮一点、暖一点」        → 理想情况应该走参数层，不走生成
  B 编辑类：「把背景换成雪山」        → 必须走生成
  C 修人类：「皮肤磨光滑、去掉痘印」  → 【最危险】最容易把脸改成 AI 脸

量化：人脸区域像素差异 + 出一张并排对比图给人眼判断。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import sys
from pathlib import Path

import requests
from PIL import Image, ImageChops, ImageDraw

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


def edit(base, key, model, image: Path, prompt: str, size: str, timeout=300):
    payload = {"model": model, "images": [{"image_url": to_data_url(image)}],
               "prompt": prompt, "n": 1, "size": size,
               "watermark": False, "prompt_extend": True, "response_format": "url"}
    for attempt in (1, 2, 3):
        try:
            r = requests.post(f"{base}/images/edits", json=payload,
                              headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
            break
        except Exception as e:
            if attempt == 3:
                return {"ok": False, "detail": f"{type(e).__name__}: {e}"}
            print(f"      (retry {attempt})")
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
    return {"ok": True, "url": urls[-1]}


def grab(url, dest: Path) -> bool:
    for a in (1, 2, 3):
        try:
            r = requests.get(url, timeout=180)
            r.raise_for_status()
            dest.write_bytes(r.content)
            return True
        except Exception:
            if a == 3:
                return False
    return False


def snap32(n: int, lo: int = 512, hi: int = 4096) -> int:
    """API 硬要求：宽高必须是 32 的倍数，且在 [512,4096] 内。"""
    n = max(lo, min(hi, int(round(n / 32)) * 32))
    return n


def face_box(W: int, H: int) -> tuple[int, int, int, int]:
    """这张人像里脸大概占据中间偏上区域。"""
    return (int(0.22 * W), int(0.05 * H), int(0.75 * W), int(0.80 * H))


def diff_stats(a: Path, b: Path) -> str:
    with Image.open(a) as A, Image.open(b) as B:
        A = A.convert("RGB").resize((600, 400))
        B = B.convert("RGB").resize((600, 400))
        x0, y0, x1, y1 = face_box(600, 400)
        d = ImageChops.difference(A, B).convert("L")
        px = d.load()
        n = tot = 0
        big = 0
        for y in range(y0, y1):
            for x in range(x0, x1):
                v = px[x, y]
                tot += v
                n += 1
                if v > 24:
                    big += 1
        return (f"脸区平均差异={tot/n:5.1f}/255   明显改动像素占比={100*big/n:5.1f}%")


def strip(paths_labels: list[tuple[Path, str]], dest: Path, cols: int = 2) -> None:
    ims = []
    for p, lab in paths_labels:
        if not p.exists():
            continue
        im = Image.open(p).convert("RGB").resize((520, 347))
        canvas = Image.new("RGB", (520, 347 + 26), (255, 255, 255))
        canvas.paste(im, (0, 26))
        d = ImageDraw.Draw(canvas)
        d.text((8, 7), lab, fill=(0, 0, 0))
        ims.append(canvas)
    if not ims:
        return
    rows = (len(ims) + cols - 1) // cols
    W, H = 520 * cols, (347 + 26) * rows
    out = Image.new("RGB", (W, H), (245, 245, 245))
    for i, im in enumerate(ims):
        out.paste(im, ((i % cols) * 520, (i // cols) * (347 + 26)))
    out.save(dest)
    print(f"  对比图 -> {dest.name}")


CASES = [
    ("A_调色", "Brighten the photo, add a warm golden tone, and increase contrast. "
               "Preserve the face, skin texture, eyes, hair, and all details exactly as they are."),
    ("B_换背景", "Change the background to a snowy mountain landscape with blue sky. "
                "Preserve the face, hair, expression, pose, and lighting on the subject exactly."),
    ("C_磨皮", "Make the skin smooth and remove blemishes and skin texture. "
              "Preserve the person's identity and facial features exactly."),
]


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    src = SPIKE / "real_1027.jpg"
    with Image.open(src) as im:
        W, H = im.size
    size = f"{snap32(W)}x{snap32(H)}"
    print(f"原图 {src.name}  {W}x{H}  ->  锁定 size={size} (对齐到 32 的倍数)\n")

    results = [(src, "原图 original")]
    for tag, prompt in CASES:
        print(f">>> {tag}")
        print(f"    {prompt[:70]}...")
        r = edit(base, key, "sensenova-u1.5-fast", src, prompt, size)
        if not r["ok"]:
            print(f"    FAILED {r['detail'][:200]}\n")
            continue
        dest = SPIKE / f"face_{tag}.png"
        if not grab(r["url"], dest):
            print("    download failed\n"); continue
        with Image.open(dest) as im:
            print(f"    输出={im.width}x{im.height}")
        print("    " + diff_stats(src, dest))
        results.append((dest, f"{tag}"))
        print()

    strip(results, SPIKE / "face_compare.jpg", cols=2)


if __name__ == "__main__":
    main()
