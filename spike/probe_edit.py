"""SPIKE / 一次性探针 —— 用来验证模型能力边界，产物是「答案」不是「代码」。
可以随时删掉，不要把它当项目正式代码去维护。

用法:
    python spike/probe_edit.py [图片路径] [--model xxx]
"""
from __future__ import annotations

import base64
import json
import mimetypes
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SPIKE = Path(__file__).resolve().parent


def load_env() -> dict[str, str]:
    env = {}
    f = ROOT / ".env"
    if not f.exists():
        sys.exit("[X] .env not found")
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def to_data_url(p: Path) -> str:
    mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def edit(base: str, key: str, model: str, image: Path, prompt: str,
         *, timeout: int = 300) -> dict:
    payload = {
        "model": model,
        "images": [{"image_url": to_data_url(image)}],
        "prompt": prompt,
        "n": 1,
        "size": "auto",
        "watermark": False,
        "prompt_extend": True,
        "response_format": "url",
    }
    try:
        r = requests.post(f"{base}/images/edits", json=payload,
                          headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
    except Exception as e:
        return {"ok": False, "stage": "request", "detail": f"{type(e).__name__}: {e}"}

    if r.status_code != 200:
        return {"ok": False, "stage": "http", "status": r.status_code,
                "detail": r.text[:600]}

    try:
        d = r.json()
    except Exception:
        return {"ok": False, "stage": "parse", "detail": r.text[:600]}

    urls = d.get("images_urls") or d.get("data") or []
    if isinstance(urls, list) and urls and isinstance(urls[0], dict):
        urls = [u.get("url") or u.get("image_url") for u in urls]
    if not urls:
        return {"ok": False, "stage": "empty", "detail": json.dumps(d)[:600]}
    return {"ok": True, "urls": urls, "raw_keys": list(d.keys())}


def grab(url: str, dest: Path) -> bool:
    try:
        r = requests.get(url, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return True
    except Exception as e:
        print(f"    [x] download failed: {e}")
        return False


def main() -> None:
    env = load_env()
    base = env["SN_BASE_URL"].rstrip("/")
    key = env["SN_API_KEY"]

    image = Path(sys.argv[1]) if len(sys.argv) > 1 else SPIKE / "input_scene.jpg"
    if not image.exists():
        sys.exit(f"[X] image not found: {image}")

    prompt = ("Make the sky a clear vivid blue. Remove the two people standing "
              "in the background. Preserve the mountains, ground, lighting, "
              "and framing.")

    models = ["sensenova-u1.5-fast", "sensenova-u1.5-lite"]
    print(f"image : {image.name}  ({image.stat().st_size // 1024} KB)")
    print(f"prompt: {prompt}")
    print("=" * 66)

    for m in models:
        print(f"\n>>> {m}")
        res = edit(base, key, m, image, prompt)
        if not res["ok"]:
            print(f"    FAILED [{res['stage']}] {res['detail']}")
            continue
        print(f"    OK  response keys={res['raw_keys']}")
        dest = SPIKE / f"out_{m}.png"
        if grab(res["urls"][-1], dest):
            print(f"    saved -> {dest.name}  ({dest.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
