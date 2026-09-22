"""SPIKE 第七轮 —— 定模型选型 + 延迟缓解手段。

第六轮发现：
  A. 账户里有 9 个模型；`sensenova-6.7-flash-lite` 确实不存在（404）。
  B. 显式写死量纲后小数问题**修好了**（3/3 都是 [-100,100] 整数）。
  C. 但 sensenova-6.8-flash-lite 有一次吐出 route="ask"——**枚举外的值**。
     所以校验层是必须的，不能信模型。
  D. 路由延迟 5~16 秒，而 spec §2.2 承诺"调色立刻生效"。
     kimi-k3 带图 16s / 不带图 8.8s；6.8-flash-lite 反而更快。

本轮要回答（都是计划二必须写死的东西）：
  1. **流式**能不能救延迟？把 param_deltas 放在 JSON 第一个键，
     测「第一个数据块」多久到 —— 那就是参数能生效的最早时刻。
  2. 建议卡片（spec §6.4）两个模型谁写得好、符不符合「12 字以内、第一人称口语」。
  3. route 枚举违规率：各跑 5 次，看谁老实。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SPIKE = Path(__file__).resolve().parent

MODELS = ["kimi-k3", "sensenova-6.8-flash-lite"]

# 关键：param_deltas 必须排在 route 之后、**其他长字段之前**。
# 流式解析时，只要这个键闭合，参数就能先落地生效，不用等 reply/edit_prompt。
ROUTER_SYSTEM = """你是修图助手的意图路由器。看照片，听懂用户的话。

只输出 JSON，不要解释。**键的顺序必须严格照下面来：**
{
  "route": "params" | "generate" | "both",
  "param_deltas": {"exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0,
                   "saturation": 0, "temperature": 0, "clarity": 0, "vignette": 0},
  "reply": "中文口语，一句话",
  "edit_prompt": "英文，只描述要改的那一处并列出要保留的",
  "needs_disambiguation": false
}

param_deltas 量纲：每个值是 **-100 到 100 的整数**，是"相对当前值再加多少"。
0 = 不动。典型幅度：轻微 10~20，明显 30~50。绝不输出 0.4 这种小数。

route 只能是 params / generate / both 三者之一，没有第四种。

调色（亮度/对比/色温/通透/饱和度）走 params；结构性改动（去人/换天/去物）走 generate。
"""

CARDS_SYSTEM = """你看这张照片，判断拍照的人最可能想改什么。

只输出 JSON，不要解释：
{"cards": ["...", "...", "..."]}

三条，每条一句话，**12 个汉字以内**，是用户自己会说的口语（第一人称），
不要专业术语（不能说"色阶""曲线""HSL""饱和度"），互相不重复。
"""


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


def post(base, key, body, stream=False, timeout=180):
    return requests.post(f"{base}/chat/completions", json=body,
                         headers={"Authorization": f"Bearer {key}"},
                         timeout=timeout, stream=stream)


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    img = SPIKE / "evidence" / "real_1027.jpg"
    img_url = to_data_url(img)
    user_img = [{"type": "image_url", "image_url": {"url": img_url}},
                {"type": "text", "text": "天太灰了，人再亮点，把后面那个人去掉"}]

    print("### 1. 流式：第一个数据块多久到（带图，各 3 次）###")
    for model in MODELS:
        ttfb, done = [], []
        for i in range(3):
            body = {"model": model,
                    "messages": [{"role": "system", "content": ROUTER_SYSTEM},
                                 {"role": "user", "content": user_img}],
                    "max_tokens": 1200, "stream": True}
            t0 = time.time()
            first = None
            try:
                with post(base, key, body, stream=True) as r:
                    if r.status_code != 200:
                        print(f"  {model} 第{i+1}次: HTTP {r.status_code} {r.text[:120]}")
                        continue
                    for line in r.iter_lines(decode_unicode=True):
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        if first is None:
                            first = time.time() - t0
            except Exception as e:
                print(f"  {model} 第{i+1}次: {type(e).__name__}: {str(e)[:100]}")
                continue
            if first is not None:
                ttfb.append(first)
                done.append(time.time() - t0)
        if ttfb:
            print(f"  {model:26} 首块 {sum(ttfb)/len(ttfb):.1f}s   全部 {sum(done)/len(done):.1f}s")

    print("\n### 2. route 枚举合规（各 5 次，带图）###")
    for model in MODELS:
        seen, bad = [], 0
        for i in range(5):
            body = {"model": model,
                    "messages": [{"role": "system", "content": ROUTER_SYSTEM},
                                 {"role": "user", "content": user_img}],
                    "max_tokens": 1200, "response_format": {"type": "json_object"}}
            try:
                r = post(base, key, body)
                if r.status_code != 200:
                    bad += 1
                    continue
                d = json.loads(r.json()["choices"][0]["message"]["content"])
                rt = d.get("route")
                seen.append(rt)
                if rt not in ("params", "generate", "both"):
                    bad += 1
            except Exception:
                bad += 1
        print(f"  {model:26} route 序列={seen}  违规 {bad}/5")

    print("\n### 3. 建议卡片质量（spec §6.4：12 字内 / 第一人称口语 / 无术语）###")
    for name in ["input_scene.jpg", "real_1027.jpg", "circle_demo.jpg"]:
        p = SPIKE / "evidence" / name
        if not p.exists():
            continue
        print(f"  --- {name} ---")
        for model in MODELS:
            body = {"model": model,
                    "messages": [{"role": "system", "content": CARDS_SYSTEM},
                                 {"role": "user",
                                  "content": [{"type": "image_url", "image_url": {"url": to_data_url(p)}}]}],
                    "max_tokens": 600, "response_format": {"type": "json_object"}}
            try:
                t0 = time.time()
                r = post(base, key, body)
                sec = time.time() - t0
                if r.status_code != 200:
                    print(f"    {model:26} HTTP {r.status_code} {r.text[:100]}")
                    continue
                d = json.loads(r.json()["choices"][0]["message"]["content"])
                cards = d.get("cards", [])
                over = [c for c in cards if len(c) > 12]
                print(f"    {model:26} {sec:4.1f}s  {cards}")
                if over:
                    print(f"        超 12 字: {over}")
            except Exception as e:
                print(f"    {model:26} {type(e).__name__}: {str(e)[:100]}")


if __name__ == "__main__":
    main()
