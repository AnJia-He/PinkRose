#!/usr/bin/env python3
"""Verify the photo focus preview in WebKit at desktop and iPhone widths."""

from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("FOCUS_BASE", "http://127.0.0.1:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTO = ROOT / "test-photos" / "e2e_portrait.jpg"


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def login(page: Page, suffix: str) -> None:
    page.goto(f"{BASE}/app", wait_until="networkidle")
    page.wait_for_selector('.login-box, input[type="file"]', timeout=15_000)
    if not page.locator(".login-box").count():
        return
    name = f"fx{suffix}{int(time.time() * 1000) % 10**10:010d}"
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


def verify(playwright, name: str, viewport: dict[str, int], touch: bool) -> None:
    browser = playwright.webkit.launch(headless=True)
    try:
        context = browser.new_context(
            viewport=viewport,
            has_touch=touch,
            is_mobile=touch,
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(str(error)))
        login(page, f"{viewport['width']}")
        errors.clear()

        picker = page.locator('input[type="file"]').first
        picker.set_input_files(str(PHOTO))
        page.wait_for_selector("canvas.canvas", timeout=20_000)
        page.locator(".nav-item", has_text="调色").first.click()
        page.wait_for_selector(".panel", timeout=15_000)
        before = page.locator("canvas.canvas").bounding_box()
        if not before:
            raise RuntimeError("canvas has no box before focus")

        focus = page.get_by_role("button", name="专注看图", exact=True)
        focus.wait_for(state="visible", timeout=10_000)
        focus_box = focus.bounding_box()
        hit_ok = True
        if touch:
            hit_ok = page.evaluate(
                """() => {
                  const button = document.querySelector('[aria-label="专注看图"]')
                  if (!(button instanceof HTMLElement)) return false
                  const box = button.getBoundingClientRect()
                  const cx = box.left + box.width / 2
                  const cy = box.top + box.height / 2
                  return [[cx, cy - 21], [cx, cy + 21], [cx - 21, cy], [cx + 21, cy]]
                    .every(([x, y]) => {
                      const hit = document.elementFromPoint(x, y)
                      return !!hit && (hit === button || button.contains(hit))
                    })
                }"""
            )
        check(
            f"{name} focus hit area",
            bool(
                focus_box
                and focus_box["width"] >= 30
                and focus_box["height"] >= 30
                and hit_ok
            ),
            f"{round(focus_box['width']) if focus_box else 0}×"
            f"{round(focus_box['height']) if focus_box else 0}",
        )
        focus.click()
        page.wait_for_function(
            "() => document.querySelector('.canvas-wrap')?.classList.contains('focused')",
            timeout=5_000,
        )
        after = page.locator("canvas.canvas").bounding_box()
        if not after:
            raise RuntimeError("canvas has no box in focus")
        before_area = before["width"] * before["height"]
        after_area = after["width"] * after["height"]
        check(
            f"{name} photo enlarged",
            after_area > before_area * 1.4,
            f"{round(before['width'])}×{round(before['height'])} → "
            f"{round(after['width'])}×{round(after['height'])}",
        )
        if name == "iPhone":
            shot_dir = ROOT / "artifacts" / "product-audit"
            shot_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(shot_dir / "iphone-focus.png"), full_page=False)
        page.keyboard.press("Escape")
        page.wait_for_function(
            "() => !document.querySelector('.canvas-wrap')?.classList.contains('focused')",
            timeout=5_000,
        )
        overflow = page.evaluate(
            "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
        )
        check(f"{name} layout", not overflow, f"overflow={overflow}")
        check(
            f"{name} console",
            not errors,
            "no errors" if not errors else " | ".join(errors[:3]),
        )
        context.close()
    finally:
        browser.close()


with sync_playwright() as playwright:
    verify(playwright, "desktop", {"width": 1280, "height": 900}, False)
    verify(playwright, "iPhone", {"width": 390, "height": 844}, True)

print("PASS photo focus preview verification")
