#!/usr/bin/env python3
"""Capture the current WebKit product surfaces for a focused UX audit."""

from __future__ import annotations

import os
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


BASE = os.environ.get("AUDIT_BASE", "http://localhost:5173")
ROOT = Path(__file__).resolve().parent.parent
PHOTO = ROOT / "test-photos" / "e2e_portrait.jpg"
OUT = ROOT / "artifacts" / "product-audit"


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
                "name": "safaricheck",
                "password": "safari-check-only",
                "email": "safaricheck@example.com",
            },
        )
        if status not in (200, "login"):
            raise RuntimeError(f"test account login/signup failed: HTTP {status}")
        page.reload(wait_until="load")
    page.wait_for_selector('.login-box, input[type="file"]', state="attached", timeout=15_000)


def open_fresh_editor(page: Page) -> None:
    deadline_ms = 30_000
    page.set_default_timeout(deadline_ms)
    fresh = page.get_by_role("button", name="新的一张", exact=True)
    if fresh.count() and fresh.is_visible():
        fresh.click()
        page.wait_for_timeout(400)
    deadline = time.monotonic() + deadline_ms / 1000
    while time.monotonic() < deadline:
        if page.locator("canvas.canvas").count():
            return
        input_box = page.locator('input[type="file"]').first
        if input_box.count():
            try:
                input_box.set_input_files(str(PHOTO), timeout=5_000)
                page.wait_for_selector("canvas.canvas", timeout=15_000)
                break
            except Exception:
                page.wait_for_timeout(300)
                continue
        page.wait_for_timeout(300)
    else:
        raise RuntimeError("timed out opening a fresh editor")
    page.wait_for_selector("canvas.canvas", state="attached", timeout=15_000)
    page.wait_for_timeout(800)


def capture(viewport_name: str, viewport: dict[str, int]) -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_responses: list[dict[str, object]] = []
    with sync_playwright() as playwright:
        browser = playwright.webkit.launch(headless=True)
        page = browser.new_page(viewport=viewport)
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: failed_responses.append(
                {"status": response.status, "url": response.url}
            )
            if response.status >= 400
            else None,
        )
        login(page)
        page.screenshot(
            path=str(OUT / f"{viewport_name}-welcome.png"),
            full_page=True,
        )
        open_fresh_editor(page)
        page.screenshot(
            path=str(OUT / f"{viewport_name}-editor.png"),
            full_page=True,
        )
        page.locator(".nav-item", has_text="调色").first.click()
        page.wait_for_selector(".panel", timeout=15_000)
        page.wait_for_timeout(500)
        page.screenshot(
            path=str(OUT / f"{viewport_name}-adjust.png"),
            full_page=True,
        )
        curve_group = page.locator(".panel-group").filter(
            has=page.locator(".panel-group-title", has_text="曲线")
        ).first
        if curve_group.count():
            head = curve_group.locator(".panel-group-head")
            if not curve_group.locator(".curve").is_visible():
                head.click()
            curve_group.locator(".curve").scroll_into_view_if_needed()
            page.wait_for_timeout(150)
            preset = curve_group.get_by_role("button", name="强对比", exact=True)
            preset.click()
            page.wait_for_timeout(150)
            page.screenshot(
                path=str(OUT / f"{viewport_name}-curve.png"),
                full_page=False,
            )
        curve_values = page.locator(".curve-value-num").all_text_contents()
        curve_presets = page.locator(".curve-presets button").count()
        metrics = page.evaluate(
            """(extra) => {
              const visible = (selector) => [...document.querySelectorAll(selector)]
                .filter((node) => {
                  const box = node.getBoundingClientRect()
                  const style = getComputedStyle(node)
                  return box.width > 0 && box.height > 0
                    && style.visibility !== 'hidden'
                    && style.display !== 'none'
                }).length
              return {
                viewport: [innerWidth, innerHeight],
                bodyScrollWidth: document.body.scrollWidth,
                canvas: (() => {
                  const node = document.querySelector('canvas.canvas')
                  if (!node) return null
                  const box = node.getBoundingClientRect()
                  return { width: box.width, height: box.height }
                })(),
                visibleTools: visible('.tool-row-main button'),
                visibleSliders: visible('.panel label.slider'),
                visibleNav: visible('.nav-item'),
                curveValues: extra.curveValues,
                curvePresets: extra.curvePresets,
              }
            }""",
            {"curveValues": curve_values, "curvePresets": curve_presets},
        )
        browser.close()
    print(
        {
            "viewport": viewport_name,
            **metrics,
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "failedResponses": failed_responses,
        }
    )


OUT.mkdir(parents=True, exist_ok=True)
capture("desktop", {"width": 1440, "height": 1000})
capture("iphone", {"width": 390, "height": 844})
