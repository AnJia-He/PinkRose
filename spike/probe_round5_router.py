"""SPIKE 第五轮 —— 意图路由的「眼睛+大脑」选型。

要回答四个问题（都是计划二绕不开的）：
  1. 今天哪些 chat 模型能吃图片输入？（第一轮测过，可能已变）
  2. 支不支持 JSON 模式（response_format=json_object）？
  3. 能不能稳定吐出 spec §6.1 那个 schema（route / param_deltas / edit_prompt / reply / needs_disambiguation）？
  4. 延迟和 token 成本各是多少？（决定 UX 和额度策略）

产物是答案，不是代码，可删。
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

CANDIDATES = [
    "kimi-k3",
    "sensenova-6.8-flash-lite",
    "sensenova-6.7-flash-lite",
    "glm-5.2",
    "deepseek-v4-flash",
]

# 模拟真实输入：多意图一句话，正好覆盖 spec §3.2 那张图
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

规则：
- 调色（亮度/对比/色温/通透/饱和度）一律走 params，用增量（相对当前值加减），不要绝对值。
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


def ask(base: str, key: str, model: str, img: Path, json_mode: bool) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": to_data_url(img)}},
                    {"type": "text", "text": USER_TEXT},
                ],
            },
        ],
        "max_tokens": 800,
        # 不传 temperature：kimi-k3 只接受 temperature=1，
        # 传 0 会被 400 拒掉（"only 1 is allowed for this model"）。
        # 各家默认值不一样，让服务端自己定，路由不需要靠 temperature 稳定。
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    t0 = time.time()
    try:
        r = requests.post(f"{base}/chat/completions", json=body,
                          headers={"Authorization": f"Bearer {key}"}, timeout=180)
    except Exception as e:
        return {"ok": False, "why": f"{type(e).__name__}: {str(e)[:150]}", "sec": time.time() - t0}

    sec = time.time() - t0
    if r.status_code != 200:
        return {"ok": False, "why": f"HTTP {r.status_code} {r.text[:200]}", "sec": sec}

    j = r.json()
    msg = j["choices"][0]["message"]
    txt = msg.get("content")
    if txt is None:
        # 有的模型把正文放在别的字段，或者只回了 reasoning。
        # 把整个 message 的结构报出来，好知道该读哪个键。
        return {"ok": False, "sec": sec,
                "why": f"message 里没有 content，实际键={sorted(msg)} 片段={json.dumps(msg, ensure_ascii=False)[:220]}"}
    return {"ok": True, "sec": sec, "text": txt, "usage": j.get("usage", {})}


def try_parse_json(text: str) -> dict | None:
    """模型常把 JSON 包在 ```json 里，或者前后带一句话。宽容一点剥。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```")[1]
        if t.startswith("json"):
            t = t[4:]
        t = t.strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    i, k = t.find("{"), t.rfind("}")
    if i >= 0 and k > i:
        try:
            return json.loads(t[i:k + 1])
        except Exception:
            return None
    return None


def check_schema(d: dict) -> list[str]:
    """返回不合规的地方，空列表 = 完全合规。"""
    bad = []
    if d.get("route") not in ("params", "generate", "both"):
        bad.append(f"route={d.get('route')!r}")
    pd = d.get("param_deltas")
    if not isinstance(pd, dict):
        bad.append("param_deltas 不是对象")
    else:
        keys = {"exposure", "contrast", "highlights", "shadows",
                "saturation", "temperature", "clarity", "vignette"}
        extra = set(pd) - keys
        if extra:
            bad.append(f"多出的键 {extra}")
    if not isinstance(d.get("reply"), str) or not d["reply"]:
        bad.append("reply 缺失")
    if not isinstance(d.get("needs_disambiguation"), bool):
        bad.append("needs_disambiguation 不是布尔")
    return bad


def main() -> None:
    env = load_env()
    base, key = env["SN_BASE_URL"].rstrip("/"), env["SN_API_KEY"]
    img = SPIKE / "evidence" / "real_1027.jpg"
    if not img.exists():
        img = SPIKE / "evidence" / "input_scene.jpg"

    print(f"底图: {img.name} ({img.stat().st_size // 1024} KB)")
    print(f"用户的话: {USER_TEXT}\n")

    for model in CANDIDATES:
        print(f"=== {model} ===")

        # 先不带 JSON 模式，纯看它能不能吃图 + 会不会自己吐 JSON
        plain = ask(base, key, model, img, json_mode=False)
        if not plain["ok"]:
            print(f"  纯文本模式: {plain['why']}  ({plain['sec']:.1f}s)\n")
            continue
        d = try_parse_json(plain["text"])
        print(f"  纯文本模式: {plain['sec']:.1f}s  usage={plain['usage']}")
        if d is None:
            print(f"    ✗ 没吐出可解析的 JSON，前 180 字：{plain['text'][:180]!r}")
        else:
            bad = check_schema(d)
            print(f"    route={d.get('route')!r}  disambig={d.get('needs_disambiguation')!r}")
            print(f"    param_deltas={json.dumps(d.get('param_deltas', {}), ensure_ascii=False)}")
            print(f"    reply={d.get('reply')!r}")
            print(f"    edit_prompt={(d.get('edit_prompt') or '')[:140]!r}")
            print(f"    schema 问题: {bad if bad else '无'}")

        # 再带 JSON 模式，看服务端支不支持
        jm = ask(base, key, model, img, json_mode=True)
        if not jm["ok"]:
            print(f"  JSON 模式: ✗ {jm['why']}")
        else:
            d2 = try_parse_json(jm["text"])
            bad2 = check_schema(d2) if d2 else ["不可解析"]
            print(f"  JSON 模式: {jm['sec']:.1f}s  schema 问题: {bad2 if bad2 else '无'}")
        print()


if __name__ == "__main__":
    main()
