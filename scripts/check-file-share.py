#!/usr/bin/env python3
"""Verify Apple file sharing wiring in WebKit without opening a native OS panel."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("FILE_SHARE_BASE", "http://127.0.0.1:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTOS = [
    ROOT / "test-photos" / "e2e_first_use.jpg",
    ROOT / "test-photos" / "e2e_portrait.jpg",
]
PORTRAIT = ROOT / "test-photos" / "e2e_portrait.jpg"
LIVE_ID = "12345678-1234-5678-9abc-def012345678"
SHARE_INIT = """
window.__ruixingShareCalls = [];
Object.defineProperty(navigator, 'canShare', {
  configurable: true,
  value: data => Array.isArray(data?.files) && data.files.length > 0,
});
Object.defineProperty(navigator, 'share', {
  configurable: true,
  value: async data => {
    window.__ruixingShareCalls.push({
      files: [...(data?.files ?? [])].map(file => ({
        name: file.name,
        type: file.type,
        size: file.size,
      })),
    });
  },
});
"""


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def login(page: Page) -> None:
    page.goto(f"{BASE}/app", wait_until="load")
    page.wait_for_selector('.login-box, input[type="file"]', state="attached", timeout=15_000)
    if page.locator(".login-box").count():
        status = page.evaluate(
            """async ({ name, password, email }) => {
              const login = await fetch('/api/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: name, password }),
              });
              if (login.ok) return 'login';
              const signup = await fetch('/api/signup', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: name, email, password }),
              });
              return signup.status;
            }""",
            {
                "name": "safaricheck",
                "password": "safari-check-only",
                "email": "safaricheck@example.com",
            },
        )
        if status not in (200, "login"):
            raise RuntimeError(f"test account login/signup failed: HTTP {status}")
        page.reload(wait_until="load")
    page.wait_for_load_state("networkidle")


def open_fresh(page: Page) -> None:
    # 自动恢复上一次会话发生在登录后的异步请求里；先让它落地，否则刚点完
    # 「新的一张」，旧画布又会被恢复回来，文件输入随手消失。
    page.wait_for_timeout(2_500)
    page.wait_for_function(
        """() => !!document.querySelector('input[data-photo-picker]')
          || [...document.querySelectorAll('button')]
            .some(button => button.textContent?.trim() === '新的一张')""",
        timeout=20_000,
    )
    fresh = page.get_by_role("button", name="新的一张", exact=True)
    if fresh.count() and fresh.is_visible():
        fresh.click()
        page.wait_for_function(
            "() => !document.querySelector('canvas.canvas')", timeout=5_000
        )
    page.wait_for_selector('input[data-photo-picker]', state="attached", timeout=15_000)
    page.wait_for_timeout(300)
    page.wait_for_selector('input[data-photo-picker]', state="attached", timeout=5_000)


def share_calls(page: Page) -> list[dict[str, object]]:
    return page.evaluate("() => window.__ruixingShareCalls ?? []")


with sync_playwright() as playwright:
    browser = playwright.webkit.launch(headless=True)
    try:
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.add_init_script(SHARE_INIT)

        page = context.new_page()
        errors: list[str] = []
        downloads: list[str] = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("download", lambda download: downloads.append(download.suggested_filename))
        login(page)
        errors.clear()

        picker = page.locator('input[type="file"][multiple]').first
        picker.set_input_files([str(path) for path in PHOTOS])
        page.wait_for_selector(".batch-page", timeout=30_000)
        page.wait_for_function(
            """() => (document.querySelector('.batch-page')?.textContent ?? '').includes('2 / 20')""",
            timeout=20_000,
        )
        page.get_by_role("button", name="开始处理", exact=True).click()
        page.get_by_role("button", name="再处理一次", exact=True).wait_for(
            state="visible", timeout=120_000
        )

        batch_share = page.get_by_role("button", name="分享 ZIP", exact=True)
        check("batch share entry visible", batch_share.count() == 1, "1 button")
        batch_share.click()
        page.wait_for_function(
            "() => (window.__ruixingShareCalls ?? []).length === 1", timeout=10_000
        )
        batch_payload = share_calls(page)[0]["files"][0]
        check(
            "batch ZIP payload",
            str(batch_payload["name"]).startswith("PinkRose-batch-")
            and str(batch_payload["name"]).endswith(".zip")
            and batch_payload["type"] == "application/zip"
            and int(batch_payload["size"]) > 0,
            str(batch_payload),
        )
        check("batch share does not download", not downloads, f"downloads={downloads}")
        check(
            "batch result note",
            "批量成片 ZIP 已分享" in page.locator(".batch-page").inner_text(),
            "shared by ZIP",
        )
        check(
            "batch 390px layout",
            not page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            ),
            "overflow=false",
        )

        live_context = browser.new_context(viewport={"width": 390, "height": 844})
        live_context.add_init_script(SHARE_INIT)
        live = live_context.new_page()
        live_errors: list[str] = []
        live_downloads: list[str] = []
        live.on("console", lambda msg: live_errors.append(msg.text) if msg.type == "error" else None)
        live.on("pageerror", lambda error: live_errors.append(str(error)))
        live.on("download", lambda download: live_downloads.append(download.suggested_filename))
        login(live)
        live_errors.clear()
        open_fresh(live)
        jpeg = PORTRAIT.read_bytes() + f"Apple MakerNote {LIVE_ID}".encode()
        mov = f"moov/meta/keys/com.apple.quicktime.content.identifier/ilst/data/{LIVE_ID}".encode()
        live.locator('input[data-photo-picker]').first.set_input_files(
            [
                {
                    "name": "IMG_9101.JPG",
                    "mimeType": "image/jpeg",
                    "buffer": jpeg,
                },
                {
                    "name": "IMG_9101.MOV",
                    "mimeType": "video/quicktime",
                    "buffer": mov,
                },
            ]
        )
        offer = live.locator(".live-photo-offer")
        offer.wait_for(state="visible", timeout=10_000)
        offer.get_by_role("button", name="修照片", exact=True).click()
        live.wait_for_selector("canvas.canvas", timeout=20_000)
        live.locator(".nav-item", has_text="调色").first.click()
        live.locator(".export-settings > summary").click()
        section = live.locator(".export-live-photo")
        section.wait_for(state="visible", timeout=10_000)
        section.locator(".live-photo-proof.verified").wait_for(state="visible", timeout=10_000)

        live_share = section.get_by_role("button", name="分享兼容包", exact=True)
        check("live photo share entry visible", live_share.count() == 1, "1 button")
        live_share.click()
        live.wait_for_function(
            "() => (window.__ruixingShareCalls ?? []).length === 1", timeout=30_000
        )
        live_payload = share_calls(live)[0]["files"][0]
        check(
            "live photo ZIP payload",
            "实况照片兼容包" in str(live_payload["name"])
            and str(live_payload["name"]).endswith(".zip")
            and live_payload["type"] == "application/zip"
            and int(live_payload["size"]) > 0,
            str(live_payload),
        )
        check(
            "live photo share does not download",
            not live_downloads,
            f"downloads={live_downloads}",
        )
        live_text = live.locator("body").inner_text()
        check(
            "live photo share note",
            "stem" in live_text and "JPG" in live_text and "MOV" in live_text,
            "通知说明 ZIP / JPG / MOV",
        )
        check(
            "live photo 390px layout",
            not live.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            ),
            "overflow=false",
        )
        check(
            "console",
            not errors and not live_errors,
            "no errors"
            if not errors and not live_errors
            else " | ".join((errors + live_errors)[:3]),
        )
    finally:
        browser.close()

print("PASS file share verification")
