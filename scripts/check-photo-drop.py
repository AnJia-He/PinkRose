#!/usr/bin/env python3
"""Verify that dropping multiple photos from the editor opens batch processing."""

from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("DROP_BASE", "http://127.0.0.1:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTO = ROOT / "test-photos" / "e2e_first_use.jpg"


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def login(page: Page, username: str) -> None:
    password = secrets.token_urlsafe(24)
    page.goto(f"{BASE}/app", wait_until="networkidle")
    page.wait_for_selector('.login-box, input[type="file"]', timeout=15_000)
    if not page.locator(".login-box").count():
        return
    status = page.evaluate(
        """async ({ name, password, email }) => {
          const login = await fetch('/api/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: name, password }),
          })
          if (login.ok) return 'login'
          const signup = await fetch('/api/signup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: name, email, password }),
          })
          return signup.status
        }""",
        {
            "name": username,
            "password": password,
            "email": f"{username}@example.com",
        },
    )
    if status not in (200, 409, "login"):
        raise RuntimeError(f"test account login/signup failed: HTTP {status}")
    page.reload(wait_until="networkidle")


def open_editor(page: Page) -> None:
    fresh = page.get_by_role("button", name="新的一张", exact=True)
    if fresh.count() and fresh.is_visible():
        fresh.click()
        page.wait_for_timeout(400)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if page.locator("canvas.canvas").count():
            page.wait_for_timeout(500)
            return
        upload = page.locator('input[type="file"]').first
        if upload.count():
            upload.set_input_files(PHOTO, timeout=8_000)
            page.wait_for_selector("canvas.canvas", timeout=15_000)
            page.wait_for_timeout(500)
            return
        page.wait_for_timeout(250)
    raise RuntimeError("timed out opening an editable photo")


def dispatch_drag(page: Page, phase: str) -> None:
    page.evaluate(
        """(phase) => {
          if (!window.__dropProbe) {
            const dt = new DataTransfer()
            dt.items.add(new File(['a'], 'drop-a.jpg', { type: 'image/jpeg' }))
            dt.items.add(new File(['b'], 'drop-b.jpg', { type: 'image/jpeg' }))
            dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }))
            window.__dropProbe = dt
          }
          document.dispatchEvent(new DragEvent(phase, {
            bubbles: true,
            cancelable: true,
            dataTransfer: window.__dropProbe,
          }))
        }""",
        phase,
    )


def verify_browser(playwright, browser_name: str, viewport: dict[str, int]) -> None:
    browser = getattr(playwright, browser_name).launch(headless=True)
    try:
        page = browser.new_page(viewport=viewport)
        errors: list[str] = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(str(error)))
        # A fresh test account avoids opening into a previously restored session.
        account = f"d{browser_name[0]}{int(time.time() * 1000) % 10**12:012d}"
        login(page, account)
        open_editor(page)
        errors.clear()

        dispatch_drag(page, "dragenter")
        overlay = page.locator(".drop-veil")
        overlay.wait_for(state="visible", timeout=5_000)
        check(
            f"{browser_name} drag hint",
            "2 张照片" in (overlay.text_content() or ""),
            (overlay.text_content() or "").strip(),
        )
        dispatch_drag(page, "dragover")
        dispatch_drag(page, "drop")

        page.wait_for_url("**/app/works", timeout=15_000)
        page.wait_for_selector(".batch-page", timeout=20_000)
        page.wait_for_function(
            """() => {
              const text = document.querySelector('.batch-page')?.textContent ?? ''
              return text.includes('drop-a.jpg')
                && text.includes('drop-b.jpg')
                && text.includes('2 / 20')
            }""",
            timeout=20_000,
        )
        text = page.locator(".batch-page").inner_text()
        check(
            f"{browser_name} batch seed",
            "drop-a.jpg" in text and "drop-b.jpg" in text and "2 / 20" in text,
            "both files and 2 / 20 are visible",
        )
        overflow = page.evaluate(
            "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
        )
        check(f"{browser_name} {viewport['width']}px layout", not overflow, f"overflow={overflow}")
        check(
            f"{browser_name} console",
            not errors,
            "no errors" if not errors else " | ".join(errors[:3]),
        )
    finally:
        browser.close()


with sync_playwright() as playwright:
    verify_browser(playwright, "chromium", {"width": 1280, "height": 900})
    verify_browser(playwright, "webkit", {"width": 390, "height": 844})

print("PASS photo drop -> batch verification")
