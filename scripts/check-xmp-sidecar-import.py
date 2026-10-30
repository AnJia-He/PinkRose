#!/usr/bin/env python3
"""Verify same-stem XMP sidecar import in WebKit at iPhone width."""

from __future__ import annotations

import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("XMP_IMPORT_BASE", "http://127.0.0.1:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTO = ROOT / "test-photos" / "e2e_first_use.jpg"
PORTRAIT = ROOT / "test-photos" / "e2e_portrait.jpg"
XMP = """<?xpacket begin=""?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:PresetName="导入配方"
      crs:Exposure2012="1.5" />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def login(page: Page) -> None:
    page.goto(f"{BASE}/app", wait_until="networkidle")
    page.wait_for_selector('.login-box, input[type="file"]', timeout=15_000)
    if not page.locator(".login-box").count():
        return
    name = f"xi{int(time.time() * 1000) % 10**12:012d}"
    password = secrets.token_urlsafe(24)
    status = page.evaluate(
        """async ({ name, password, email }) => {
          const response = await fetch('/api/signup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: name, email, password }),
          })
          return response.status
        }""",
        {
            "name": name,
            "password": password,
            "email": f"{name}@example.com",
        },
    )
    if status != 200:
        raise RuntimeError(f"test account signup failed: HTTP {status}")
    page.reload(wait_until="networkidle")


with tempfile.TemporaryDirectory(prefix="pinkrose-xmp-") as temp:
    sidecar = Path(temp) / "e2e_first_use.xmp"
    sidecar.write_text(XMP, encoding="utf-8")

    with sync_playwright() as playwright:
        browser = playwright.webkit.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 390, "height": 844})
            errors: list[str] = []
            page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda error: errors.append(str(error)))
            login(page)
            errors.clear()

            picker = page.locator('input[type="file"]').first
            check(
                "picker accepts XMP",
                ".xmp" in (picker.get_attribute("accept") or ""),
                picker.get_attribute("accept") or "missing",
            )
            picker.set_input_files([str(PHOTO), str(sidecar)])
            page.wait_for_selector("canvas.canvas", timeout=20_000)
            page.wait_for_function(
                """() => (document.body.textContent ?? '').includes('已套用同名 XMP 调色旁车「导入配方」')""",
                timeout=20_000,
            )
            page.locator(".nav-item", has_text="调色").first.click()
            page.wait_for_selector(".panel", timeout=15_000)
            page.wait_for_function(
                """() => {
                  const label = [...document.querySelectorAll('.panel label.slider')]
                    .find(node => node.querySelector('.slider-label')?.textContent?.trim() === '亮度')
                  return label?.querySelector('.slider-value')?.textContent?.trim() === '30'
                }""",
                timeout=10_000,
            )
            check("sidecar parameters applied", True, "exposure slider = 30")

            # 一次选择多张照片和各自旁车：应进批量页，并在处理时逐张读取。
            page.get_by_role("button", name="新的一张", exact=True).click()
            page.locator(".nav-item", has_text="修图").first.click()
            portrait_xmp = Path(temp) / "e2e_portrait.xmp"
            portrait_xmp.write_text(
                XMP.replace('crs:PresetName="导入配方"', 'crs:PresetName="批量配方"')
                .replace('crs:Exposure2012="1.5"', 'crs:Exposure2012="-0.5"'),
                encoding="utf-8",
            )
            picker = page.locator('input[data-photo-picker]').first
            picker.set_input_files([
                str(PHOTO),
                str(sidecar),
                str(PORTRAIT),
                str(portrait_xmp),
            ])
            page.wait_for_selector(".batch-page", timeout=30_000)
            page.wait_for_function(
                """() => (document.body.textContent ?? '').includes('已匹配 2 份同名 XMP')""",
                timeout=20_000,
            )
            page.get_by_role("button", name="开始处理", exact=True).click()
            page.wait_for_function(
                """() => (document.body.textContent ?? '').includes(
                  '2 张使用了各自的 XMP 调色旁车'
                )""",
                timeout=120_000,
            )
            check("batch sidecars applied", True, "2 photos used their own XMP")
            overflow = page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            check("390px layout", not overflow, f"overflow={overflow}")
            check(
                "console",
                not errors,
                "no errors" if not errors else " | ".join(errors[:3]),
            )
        finally:
            browser.close()

print("PASS XMP sidecar import verification")
