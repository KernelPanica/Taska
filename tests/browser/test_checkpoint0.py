import os
from pathlib import Path
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase

from taska.projects.models import Board, Membership, Project, Status


@skipUnless(
    os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run the real browser checkpoint."
)
class CheckpointBrowserTests(StaticLiveServerTestCase):
    def test_login_empty_board_language_keyboard_and_responsive_layout(self):
        from playwright.sync_api import expect, sync_playwright

        user = get_user_model().objects.create_user("browser-member", password="test-password")
        project = Project.objects.create(key="TASKA", name="Taska")
        Membership.objects.create(project=project, user=user)
        Board.objects.create(project=project, name="Team board")
        for position, (name, category) in enumerate(
            (("To do", "queue"), ("In progress", "active"), ("Done", "done"))
        ):
            Status.objects.create(project=project, name=name, category=category, position=position)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
            page.goto(self.live_server_url + "/login/")
            page.get_by_label("Username").fill("browser-member")
            page.get_by_label("Password").fill("test-password")
            page.get_by_role("button", name="Sign in", exact=True).click()
            page.goto(self.live_server_url + "/projects/")
            page.get_by_role("link").filter(
                has=page.get_by_role("heading", name="Taska", exact=True)
            ).click()
            expect(page.get_by_text("No issues in this status", exact=True)).to_have_count(3)
            expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            page.reload()
            expect(page.get_by_text("No issues in this status", exact=True)).to_have_count(3)
            self.assertEqual(
                page.request.get(self.live_server_url + "/api/projects/TASKA/issues/").json(),
                {"issues": []},
            )
            page.get_by_role("button", name="RU", exact=True).click()
            expect(page.locator("html")).to_have_attribute("lang", "ru")
            expect(page.get_by_text("В этом статусе пока нет задач", exact=True)).to_have_count(3)
            for width in (360, 768, 1280, 1920):
                page.set_viewport_size({"width": width, "height": 900})
                self.assertTrue(
                    page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
                    f"Overflow at {width}px",
                )
                expect(page.get_by_role("button", name="RU", exact=True)).to_be_visible()
            page.set_viewport_size({"width": 360, "height": 900})
            page.get_by_role("region", name="Доска проекта").focus()
            self.assertEqual(
                page.evaluate("getComputedStyle(document.activeElement).outlineStyle"), "solid"
            )
            page.keyboard.press("ArrowRight")
            page.emulate_media(reduced_motion="reduce")
            self.assertEqual(
                page.evaluate(
                    "getComputedStyle(document.querySelector('button')).transitionDuration"
                ),
                "0.001s",
            )
            # Automated contrast check on the core text and action token pairs.
            contrast = page.evaluate("""() => {
              const s = getComputedStyle(document.documentElement);
              const luminance = name => {
                const hex = s.getPropertyValue(name).trim().slice(1);
                const rgb = [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)/255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4);
                return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
              };
              return [['--color-text-primary','--color-surface-2'],['--color-text-secondary','--color-surface-1'],['--color-on-primary','--color-primary']].map(([a,b]) => {
                const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
              });
            }""")
            self.assertTrue(all(ratio >= 4.5 for ratio in contrast))
            Path("artifacts").mkdir(exist_ok=True)
            page.locator(".board").evaluate("element => element.scrollLeft = 0")
            page.screenshot(path="artifacts/checkpoint0-mobile.png", full_page=True)
            page.set_viewport_size({"width": 1280, "height": 900})
            page.screenshot(path="artifacts/checkpoint0-desktop.png", full_page=True)
            # Every existing page must still fit after the shared-shell redesign.
            for route in ("/", "/projects/", "/boards/"):
                page.goto(self.live_server_url + route)
                for width in (360, 1280):
                    page.set_viewport_size({"width": width, "height": 900})
                    expect(page.locator("html")).to_have_js_property("scrollWidth", width)

            browser.close()
