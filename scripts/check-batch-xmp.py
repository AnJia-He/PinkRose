#!/usr/bin/env python3
"""Export two photos in WebKit and inspect the XMP sidecars inside the ZIP."""

from __future__ import annotations

import os
import secrets
import sys
import time
import zipfile
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("BATCH_XMP_BASE", "http://127.0.0.1:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTOS = [
    ROOT / "test-photos" / "e2e_first_use.jpg",
    ROOT / "test-photos" / "e2e_portrait.jpg",
]


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def login(page: Page) -> None:
    page.goto(f"{BASE}/app", wait_until="networkidle")
    page.wait_for_selector('.login-box, input[type="file"]', timeout=15_000)
    if not page.locator(".login-box").count():
        return
    name = f"bx{int(time.time() * 1000) % 10**12:012d}"
    password = secrets.token_urlsafe(24)
    status = page.evaluate(
        """async ({ name, password, email }) => {
          const signup = await fetch('/api/signup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: name, email, password }),
          })
          return signup.status
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


with sync_playwright() as playwright:
    browser = playwright.webkit.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 390, "height": 844})
        errors: list[str] = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(str(error)))
        login(page)
        errors.clear()

        picker = page.locator('input[type="file"][multiple]').first
        picker.set_input_files([str(path) for path in PHOTOS])
        page.wait_for_selector(".batch-page", timeout=30_000)
        page.wait_for_function(
            """() => (document.querySelector('.batch-page')?.textContent ?? '').includes('2 / 20')""",
            timeout=20_000,
        )

        xmp_toggle = page.locator("label.batch-toggle").filter(
            has_text="附带 XMP 调色配方"
        ).locator('input[type="checkbox"]')
        xmp_toggle.check()
        page.get_by_role("button", name="开始处理", exact=True).click()
        page.wait_for_selector("button.batch-download", timeout=120_000)
        run_button = page.get_by_role("button", name="再处理一次", exact=True)
        run_button.wait_for(state="visible", timeout=120_000)

        download_button = page.get_by_role("button", name="下载 ZIP", exact=True)
        with page.expect_download(timeout=30_000) as event:
            download_button.click()
        download = event.value
        path = Path(download.path())
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            xmp_names = [name for name in names if name.lower().endswith(".xmp")]
            jpg_names = [name for name in names if name.lower().endswith(".jpg")]
            check("sidecar count", len(xmp_names) == 2, f"{len(xmp_names)} XMP + {len(jpg_names)} JPG")
            check("image count", len(jpg_names) == 2, ", ".join(jpg_names))
            stems = {Path(name).stem for name in jpg_names}
            sidecar_stems = {Path(name).stem for name in xmp_names}
            check("matching basenames", stems == sidecar_stems, f"{sorted(stems)}")
            xmp_text = archive.read(xmp_names[0]).decode("utf-8")
            check(
                "XMP fields",
                "<x:xmpmeta" in xmp_text
                and "crs:Exposure2012" in xmp_text
                and "pinkrose:exposure" in xmp_text,
                f"{len(xmp_text)} bytes",
            )

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

print("PASS batch XMP export verification")
