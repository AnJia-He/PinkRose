#!/usr/bin/env python3
"""Verify tether-folder XMP sidecars flow into batch processing in WebKit."""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

APP = os.environ.get("CAMERA_XMP_APP", "http://127.0.0.1:5173")
BRIDGE_PORT = int(os.environ.get("CAMERA_XMP_PORT", "8793"))
BRIDGE = f"http://127.0.0.1:{BRIDGE_PORT}"
ROOT = Path(__file__).resolve().parent.parent
PHOTOS = [
    ROOT / "test-photos" / "e2e_first_use.jpg",
    ROOT / "test-photos" / "e2e_portrait.jpg",
]
XMP = """<?xpacket begin=""?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:PresetName="Tether 配方"
      crs:Exposure2012="0.6" />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def wait_bridge() -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{BRIDGE}/api/camera/health", timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("camera bridge did not start")


def login(page: Page) -> None:
    page.goto(f"{APP}/app", wait_until="networkidle")
    page.wait_for_selector('.login-box, input[type="file"]', timeout=15_000)
    if not page.locator(".login-box").count():
        return
    name = f"cx{int(time.time() * 1000) % 10**12:012d}"
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


with tempfile.TemporaryDirectory(prefix="pinkrose-camera-xmp-") as folder:
    camera_root = Path(folder)
    for index, source in enumerate(PHOTOS, start=1):
        photo_name = f"IMG_{index:04d}.jpg"
        sidecar_name = f"IMG_{index:04d}.xmp"
        shutil.copyfile(source, camera_root / photo_name)
        (camera_root / sidecar_name).write_text(XMP, encoding="utf-8")

    bridge = subprocess.Popen(
        [
            "node",
            "scripts/camera-bridge.ts",
            "--dir",
            str(camera_root),
            "--port",
            str(BRIDGE_PORT),
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_bridge()
        with sync_playwright() as playwright:
            browser = playwright.webkit.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 390, "height": 844})
                errors: list[str] = []
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                page.on("pageerror", lambda error: errors.append(str(error)))
                login(page)
                errors.clear()

                page.get_by_role("button", name="相机桥", exact=True).click()
                page.locator('[aria-label="相机桥地址"]').fill(BRIDGE)
                page.get_by_role("button", name="连接", exact=True).click()
                page.wait_for_selector(".bridge-photo", timeout=20_000)
                check(
                    "photo count",
                    page.locator(".bridge-photo").count() == 2,
                    f"count={page.locator('.bridge-photo').count()}",
                )
                check(
                    "sidecar badge",
                    page.locator(".bridge-photo .bridge-pair", has_text="XMP").count() == 2,
                    f"count={page.locator('.bridge-photo .bridge-pair', has_text='XMP').count()}",
                )
                page.get_by_role("button", name="导入全部", exact=True).click()
                page.wait_for_selector(".batch-page", timeout=30_000)
                page.wait_for_function(
                    """() => (document.body.textContent ?? '').includes('已匹配 2 份同名 XMP')""",
                    timeout=20_000,
                )
                check("batch matched sidecars", True, "2 XMP sidecars paired")
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
    finally:
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()

print("PASS camera XMP sidecar verification")
