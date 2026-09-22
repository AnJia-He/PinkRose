"""SPIKE 第六轮 —— 把第五轮暴露的三个问题钉死。

第五轮发现：
  A. kimi-k3 吐的 param_deltas 是 **0.4 / 0.05 这种小数**，不是 [-100,100] 的整数。
     它是自己脑补了 [-1,1] 的量纲。必须确认加一句显式范围说明能不能修好，且稳不稳。
  B. glm-5.2 / deepseek-v4-flash 把 800 个 max_tokens **全花在 reasoning 上**，
     正文被截断成空——max_tokens 必须cover reasoning tokens，这是个坑。
  C. 路由一次要 11~13 秒。spec §1.2 的成败线是「30 秒发朋友圈」，
     这 12 秒必须先说清楚能不能压。

本轮要回答：
  1. 账户里到底有哪些 chat 模型可用（/models）
  2. 显式写死量纲后，两个候选各跑 3 次，param_deltas 稳不稳、是不是整数
  3. 带图 vs 不带图，延迟差多少（能不能靠省图提速）
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
USER_TEXT = "天太灰了，人再亮点，把后面那个人去掉"

SYSTEM = """你是修图助手的意图路由器。看照片，听懂用户的话，决定怎么改。

只输出 JSON，不要任何解释文字。格式：
{
  "route": "params" | "generate" | "both",
  "param_deltas": {"exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0,
                   "saturation": 0, "temperature": 0, "clarity": 0, "vignette": 0},
  "edit_prompt": "英文，只描述要改的那一处，并显式列出要保留的东西",
  "reply": "中文口语回复，一句话，不要术语",
  "needs_disambiguation": false
}

**param_deltas 的量纲（最容易错，务必遵守）：**
- 每个值是 **-100 到 100 之间的整数**，表示"相对用户当前值再加多少"。
- 0 表示这个参数不用动。
- 典型幅度：轻微 +10~20，明显 +30~50，拉满 +70~100。
- 绝对不要输出 0.4、0.05 这种小数——那是把量纲当成了 -1~1。

规则：
- 调色（亮度/对比/色温/通透/饱和度）一律走 params，用增量，不要绝对值。
- 只有结构性改动（去人/换天/去物）才走 generate。
- 两种都有就 both。
- 照片里有多个人而用户说"那个人"时，needs_disambiguation 置 true。
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


def ask(base, key, model, content, max_tokens=1200):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": content}],
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    t0 = time.time()
    try:
        r = requests.post(f"{base}/chat/completions", json=body,
                          headers={"Authorization": f"Bearer {key}"}, timeout=180)
    except Exception as e:
        return {"ok": False, "sec": time.time() - t0, "why": f"{type(e).__name__}: {str(e)[:120]}"}
    sec = time.time() - t0
    if r.status_code != 200:
        return {"ok": False, "sec": sec, "why": f"HTTP {r.status_code} {r.text[:160]}"}
    j = r.json()
    msg = j["choices"][0]["message"]
    return {"ok": True, "sec": sec, "text": msg.get("content") or "",
            "usage": j.get("usage", {}), "finish": j["choices"][0].get("finish_reason")}


def parse(text):
    try:
        return json.loads(text)
    except Exception:
        i, k = text.find("{"), text.rfind("}")
        if i >= 0 and k > i:
            try:
                return json.loads(text[i:k + 1])
            except Exception:
                return None
    return None


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    img = SPIKE / "evidence" / "real_1027.jpg"

    print("### 1. 账户里可用的模型 ###")
    try:
        r = requests.get(f"{base}/models", headers={"Authorization": f"Bearer {key}"}, timeout=30)
        if r.status_code == 200:
            ids = [m.get("id") for m in r.json().get("data", [])]
            print(f"  {len(ids)} 个: {ids}")
        else:
            print(f"  HTTP {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"  {type(e).__name__}: {e}")

    content_with_img = [
        {"type": "image_url", "image_url": {"url": to_data_url(img)}},
        {"type": "text", "text": USER_TEXT},
    ]
    content_text_only = [{"type": "text", "text": USER_TEXT}]

    print("\n### 2. 显式写死量纲后，param_deltas 稳不稳（各 3 次，带图）###")
    for model in MODELS:
        print(f"  --- {model} ---")
        for i in range(3):
            res = ask(base, key, model, content_with_img)
            if not res["ok"]:
                print(f"    第{i+1}次: ✗ {res['why']}  ({res['sec']:.1f}s)")
                continue
            d = parse(res["text"])
            if d is None:
                print(f"    第{i+1}次: ✗ JSON 不可解析 ({res['sec']:.1f}s) {res['text'][:100]!r}")
                continue
            pd = d.get("param_deltas", {})
            vals = [v for v in pd.values() if isinstance(v, (int, float))]
            frac = [v for v in vals if isinstance(v, float) and v != int(v)]
            u = res["usage"]
            print(f"    第{i+1}次: {res['sec']:.1f}s  route={d.get('route')!r}  "
                  f"completion={u.get('completion_tokens')} "
                  f"(reasoning={u.get('completion_tokens_details', {}).get('reasoning_tokens')})")
            print(f"           deltas={json.dumps(pd, ensure_ascii=False)}")
            print(f"           小数={frac if frac else '无'}  超范围={[v for v in vals if abs(v) > 100] or '无'}")

    print("\n### 3. 带图 vs 不带图，延迟差多少（各 2 次）###")
    for model in MODELS:
        for label, content in (("带图", content_with_img), ("不带图", content_text_only)):
            secs = []
            ok = 0
            for _ in range(2):
                res = ask(base, key, model, content)
                secs.append(res["sec"])
                ok += 1 if res["ok"] else 0
            print(f"  {model:28} {label:4} {sum(secs)/len(secs):5.1f}s  (成功 {ok}/2)")


if __name__ == "__main__":
    main()
