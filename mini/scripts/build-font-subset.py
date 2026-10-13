# -*- coding: utf-8 -*-
"""
构建小程序的内嵌字体（Task 15 · 设计打磨轮）—— 一次性把字符集 + 子集 + base64
全跑出来，产物写进 mini/styles/fonts.wxss。

产物三份（wxss 的 @font-face 不吃本地文件 url，只认 base64 / https，所以全部内嵌）：
  · MiSans Mini 400  —— src/assets/fonts/misans/ 那 56 片 VF 切片里、覆盖当前
  · MiSans Mini 600     字符集的若干片 → 每片实例化成静态字重 → 合并 → 子集化 →
                        woff2 → base64（400/600 两份静态，电脑版也就这两档字重）
  · PinkRose Wordmark —— src/assets/fonts/pinkrose-wordmark.woff2 原样 base64
                        （Playfair Display SemiBold 子集，"PinkRose" 那 9 个字形）

字符集 = mini/ 下全部 .ts + .wxml（**排除 mini/types/** —— 那是本机
prepare-types.cmd 生成的官方 typings、不随仓库走，扫进来会让产物因机器而异）
剥注释（ts 的块/行注释、wxml 的 <!-- -->）后的唯一字符。快照写回
mini/scripts/font-subset-chars.txt —— **加了固定文案（按钮/顶栏/风格名/系统小字…）
就重跑本脚本**，字符集跟着更新。

用法（⚠️ 必须用 anaconda 的 python —— 它带 brotlicffi，fontTools 读写 woff2 全靠它；
D:\\python314 那份 fontTools 没 brotli，woff2 直接 ImportError）：
  C:\\Users\\Administrator\\anaconda3\\python.exe mini/scripts/build-font-subset.py
（anaconda 在 PATH 里时，直接 python mini/scripts/build-font-subset.py 也行）

中间产物（解码的切片 / 实例化的静态字体 / 合并字体）落在系统临时目录下的
pr-font-build/ —— **别放进 mini/**，会占主包体积。
"""
import base64
import hashlib
import os
import re
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding='utf-8')

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

PY = sys.executable
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MINI = os.path.dirname(SCRIPT_DIR)                    # mini/
ROOT = os.path.dirname(MINI)                          # 仓库根
FONTDIR = os.path.join(ROOT, 'src', 'assets', 'fonts', 'misans')
WORDMARK = os.path.join(ROOT, 'src', 'assets', 'fonts', 'pinkrose-wordmark.woff2')
CHARS_TXT = os.path.join(SCRIPT_DIR, 'font-subset-chars.txt')
OUT_WXSS = os.path.join(MINI, 'styles', 'fonts.wxss')
TMP = os.path.join(tempfile.gettempdir(), 'pr-font-build')


# ── 1. 字符集：扫 mini/ 的 ts + wxml，剥注释，取唯一字符 ──────────────────────

def strip_ts(text):
    """ts：先挖掉块注释，再挖行注释。行注释带个 (?<!:) —— 别把字符串里的
    `http://…` 一起吃掉（那几个字符合法地属于源码）。"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(?<!:)//[^\n]*', '', text)


def strip_wxml(text):
    return re.sub(r'<!--.*?-->', '', text, flags=re.S)


def collect_chars():
    chars = set()
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(MINI):
        # mini/types/ = 本机的官方 typings（不随仓库走）—— 扫进来产物就因机器而异
        dirnames[:] = [d for d in dirnames if d != 'types' and d != 'node_modules']
        for name in filenames:
            ext = os.path.splitext(name)[1]
            if ext not in ('.ts', '.wxml'):
                continue
            p = os.path.join(dirpath, name)
            with open(p, encoding='utf-8', errors='replace') as f:
                text = f.read()
            text = strip_wxml(text) if ext == '.wxml' else strip_ts(text)
            for ch in text:
                if ch not in '\n\r\t':
                    chars.add(ch)
            scanned += 1
    return ''.join(sorted(chars)), scanned


# ── 2. MiSans 切片覆盖分析（unicode-range 对字符集）──────────────────────────

def parse_faces():
    css = open(os.path.join(FONTDIR, 'misans.css'), encoding='utf8').read()
    faces = []
    for m in re.finditer(r"src:\s*url\('([^']+)'\)[^;]*;unicode-range:([^;}]+)", css):
        name = m.group(1)
        cps = set()
        for part in m.group(2).split(','):
            t = part.strip().lower().replace('u+', '')
            if not t:
                continue
            if '-' in t:
                a, b = t.split('-')
                cps |= set(range(int(a, 16), int(b, 16) + 1))
            else:
                cps.add(int(t, 16))
        faces.append((name, cps))
    return faces


# ── 3. 构建 ──────────────────────────────────────────────────────────────────

def build_static_subset(ttfs, wght, chars, chars_hash):
    """逐片实例化到静态 wght → 合并 → 按字符集子集化成 woff2。返回产物路径。"""
    statics = []
    for t in ttfs:
        out = t.replace('.ttf', '.w%d.ttf' % wght)
        if not os.path.exists(out):
            f = instancer.instantiateVariableFont(TTFont(t), {'wght': wght})
            f.save(out)
            f.close()
        statics.append(out)
    merged = os.path.join(TMP, 'merged-w%d.ttf' % wght)
    if not os.path.exists(merged):
        fo = Merger().merge(statics)
        fo.save(merged)
        fo.close()
    o = os.path.join(TMP, 'subset-w%d-%s.woff2' % (wght, chars_hash))
    if not os.path.exists(o):
        rr = subprocess.run([PY, '-m', 'fontTools.subset', merged,
                             '--text-file=' + CHARS_TXT, '--flavor=woff2',
                             '--output-file=' + o, '--layout-features=', '--no-hinting'],
                            capture_output=True, text=True, encoding='utf8', errors='replace')
        if rr.returncode != 0 or not os.path.exists(o):
            print((rr.stderr or '')[-800:])
            raise SystemExit('子集化失败（wght=%d）' % wght)
    return o


def covered_by(path):
    """一个 woff2 实际覆盖的码点（读 cmap）。"""
    f = TTFont(path)
    cps = set(f.getBestCmap().keys())
    f.close()
    return cps


def face_rule(family, weight, b64):
    return (
        "@font-face {\n"
        "  font-family: '%s';\n"
        "  src: url('data:font/woff2;base64,%s') format('woff2');\n"
        "  font-weight: %d;\n"
        "  font-style: normal;\n"
        "  font-display: swap;\n"
        "}" % (family, b64, weight)
    )


def main():
    if not os.path.exists(os.path.join(FONTDIR, 'misans.css')):
        raise SystemExit('找不到 MiSans 切片：' + FONTDIR)
    if not os.path.exists(WORDMARK):
        raise SystemExit('找不到字标：' + WORDMARK)
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_WXSS), exist_ok=True)

    # 1) 字符集（快照写回）
    chars, scanned = collect_chars()
    needed = set(map(ord, chars))  # 码点集合（unicode-range / cmap 都是码点，别拿字符去比）
    print('[1] 字符集：%d 个唯一字符（扫了 %d 个 ts/wxml；不含 \\n\\r\\t）' % (len(needed), scanned))
    with open(CHARS_TXT, 'w', encoding='utf-8') as f:
        f.write(chars + '\n')

    # 2) 覆盖分析
    faces = parse_faces()
    cover = [(name, cps & needed) for name, cps in faces]
    cover = [(name, c) for name, c in cover if c]
    allcp = set()
    for _, cps in faces:
        allcp |= cps
    miss_slice = needed - allcp
    print('[2] 切片覆盖：命中 %d 片；切片清单外的字符 %d 个 %s'
          % (len(cover), len(miss_slice),
             repr(''.join(chr(c) for c in sorted(miss_slice))) if miss_slice else ''))

    # 3) 解码命中的切片（woff2 → ttf；缓存）
    dec_dir = os.path.join(TMP, 'slices')
    os.makedirs(dec_dir, exist_ok=True)
    ttfs = []
    for name, _ in cover:
        out = os.path.join(dec_dir, name.replace('.woff2', '.ttf'))
        if not os.path.exists(out):
            font = TTFont(os.path.join(FONTDIR, name))
            font.flavor = None
            font.save(out)
            font.close()
        ttfs.append(out)
    print('[3] 解码切片：%d 片 → %s' % (len(ttfs), dec_dir))

    # 4) 两档静态子集
    chars_hash = hashlib.md5(chars.encode('utf-8')).hexdigest()[:8]
    subsets = {}
    for wght in (400, 600):
        p = build_static_subset(ttfs, wght, chars, chars_hash)
        subsets[wght] = p
        print('[4] MiSans %d 子集：%s（%.1fKB）' % (wght, os.path.basename(p), os.path.getsize(p) / 1024))

    # 5) 实际覆盖报告（以 400 那份的 cmap 为准 —— 两档字符集相同）
    real_cov = covered_by(subsets[400])
    miss_subset = needed - real_cov
    print('[5] 子集**实际**未覆盖：%d 个 %s（这些字渲染时掉回系统字体；'
          '电脑版 MiSans 同样缺这几个，"？"是全家缺）'
          % (len(miss_subset), repr(''.join(chr(c) for c in sorted(miss_subset)))))

    # 6) base64 汇总 + 写 wxss
    b64 = {}
    for wght, p in subsets.items():
        b64[wght] = base64.b64encode(open(p, 'rb').read()).decode('ascii')
    b64_wordmark = base64.b64encode(open(WORDMARK, 'rb').read()).decode('ascii')

    header = (
        "/* ─────────────────────────────────────────────────────────────────────\n"
        "   fonts.wxss —— 自动生成，勿手改。\n"
        "   重建命令：python mini/scripts/build-font-subset.py\n"
        "   （字符集从 mini/ 的 ts+wxml 剥注释全量取，快照见 mini/scripts/font-subset-chars.txt；\n"
        "     加了固定文案要重跑，否则新字掉系统字体。）\n"
        "   内容：MiSans 静态子集 400 / 600 + PinkRose 字标，全部 base64 内嵌\n"
        "   （wxss 的 @font-face 不吃本地文件 url，只认 base64 / https 地址）。\n"
        "   ⚠️ 家族名故意叫 \"MiSans Mini\" —— 别改回 \"MiSans\"（会和系统里\n"
        "      可能存在的同名家族撞）。接线（page / 动态内容回系统栈 / 字标）在 app.wxss。\n"
        "   ───────────────────────────────────────────────────────────────────── */\n"
    )
    rules = [
        face_rule('MiSans Mini', 400, b64[400]),
        face_rule('MiSans Mini', 600, b64[600]),
        face_rule('PinkRose Wordmark', 600, b64_wordmark),
    ]
    with open(OUT_WXSS, 'w', encoding='utf-8') as f:
        f.write(header + '\n' + '\n'.join(rules) + '\n')

    total = len(b64[400]) + len(b64[600]) + len(b64_wordmark)
    print('[6] 写进 %s' % OUT_WXSS)
    print('    MiSans 400 base64 %.1fKB / 600 %.1fKB / 字标 %.1fKB —— 合计 %.1fKB（进包增量）'
          % (len(b64[400]) / 1024, len(b64[600]) / 1024, len(b64_wordmark) / 1024, total / 1024))
    print('DONE')


if __name__ == '__main__':
    main()
