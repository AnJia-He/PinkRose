"""SPIKE 第二轮 —— 确认三件事：
  1. size 参数能不能锁住输出分辨率（不然每次出图尺寸都变，产品没法做）
  2. VLM（sensenova-6.8-flash-lite）能不能"看懂"照片（意图路由的「眼睛」）
  3. lite 模型补测
产物是答案，不是代码，可删。
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
    payload = {
        "model": model,
        "images": [{"image_url": to_data_url(image)}],
        "prompt": prompt,
        "n": 1,
        "size": size or "auto",
        "watermark": False,
        "prompt_extend": True,
        "response_format": "url",
    }
    try:
        r = requests.post(f"{base}/images/edits", json=payload,
                          headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
    except Exception as e:
        return {"ok": False, "detail": f"{type(e).__name__}: {e}"}
    if r.status_code != 200:
        return {"ok": False, "detail": f"HTTP {r.status_code}: {r.text[:400]}"}
    d = r.json()
    if r.status_code != 200:
        return {"ok": False, "detail": f"HTTP {r.status_code}: {r.text[:400]}"}
    urls = d.get("images_urls") or []
    if not urls:
        urls = [u.get("url") or u.get("image_url") for u in (d.get("data") or [])
                if isinstance(u, dict)]
    urls = [u for u in urls if u]
    if not urls:
        return {"ok": False, "detail": json.dumps(d)[:400]}
    return {"ok": True, "url": urls[-1], "size": d.get("size"), "usage": d.get("usage")}


def grab(url, dest: Path):
    try:
        r = requests.get(url, timeout=180)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return True
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:120]}"


def dims(p: Path) -> str:
    try:
        from PIL import Image
        with Image.open(p) as im:
            return f"{im.width}x{im.height}"
    except Exception as e:
        return f"?{e}"


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    img = SPIKE / "input_scene.jpg"
    prompt = "Make the sky a clear vivid blue. Preserve mountains, ground, lighting, and framing."

    print("### 1. size 参数能否锁住输出尺寸（原图 1024x768）###")
    for s in ["auto", "1024x768", "1024x1024", "2048x1536"]:
        r = edit(base, key, "sensenova-u1.5-fast", img, prompt, size=s)
        if not r["ok"]:
            print(f"  size={s!r:12} -> FAILED  {r['detail'][:200]}")
            continue
        dest = SPIKE / f"sz_{s}.png"
        g = grab(r["url"], dest)
        got = dims(dest) if g is True else "-"
        print(f"  size={s!r:12} -> OK  实际输出={got}  resp.size={r['size']}")

    print("\n### 2. VLM 能不能看懂照片 ###")
    for model in ["sensenova-6.8-flash-lite", "sensenova-6.7-flash-lite",
                  "glm-5.2", "deepseek-v4-flash", "kimi-k3", "sensenova-u1.5-fast"]:
        body = {
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": to_data_url(img)}},
                    {"type": "text", "text": "用一句话描述这张照片：天空什么颜色？画面里有几个人？地平线大概在画面高度的百分之几？"},
                ],
            }],
            "max_tokens": 300,
        }
        try:
            r = requests.post(f"{base}/chat/completions", json=body,
                              headers={"Authorization": f"Bearer {key}"}, timeout=180)
            if r.status_code != 200:
                print(f"  {model}: HTTP {r.status_code} {r.text[:250]}")
                continue
            txt = r.json()["choices"][0]["message"]["content"]
            print(f"  {model}: {txt.strip()[:220]}")
        except Exception as e:
            print(f"  {model}: {type(e).__name__}: {str(e)[:200]}")

    print("\n### 3. lite 补测 ###")
    r = edit(base, key, "sensenova-u1.5-lite", img, prompt)
    if r["ok"]:
        g = grab(r["url"], SPIKE / "out_lite_retry.png")
        print(f"  lite -> OK  resp.size={r['size']}  dl={g if g is not True else 'out_lite_retry.png'}")
        print(f"  usage={r['usage']}")
    else:
        print(f"  lite -> FAILED {r['detail'][:250]}")


if __name__ == "__main__":
    main()
