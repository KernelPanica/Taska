import io
import os
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from PIL import Image

from taska.projects.models import IssueType, Membership, Project, Status, Tag


@skipUnless(os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run browser checks.")
class EditorUITests(StaticLiveServerTestCase):
    def test_editor_tags_watch_profile_and_status_controls(self):
        from playwright.sync_api import expect, sync_playwright

        person = get_user_model().objects.create_user("editor", password="test-password")
        project = Project.objects.create(key="EDIT", name="Editor project")
        Membership.objects.create(project=project, user=person, role="manager")
        Status.objects.create(project=project, name="Queue", category="queue")
        active = Status.objects.create(project=project, name="Working", category="active")
        IssueType.objects.create(project=project, name="Task")
        Tag.objects.create(project=project, name="backend")
        picture = io.BytesIO()
        Image.new("RGB", (64, 64), "green").save(picture, format="PNG")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
            page.goto(self.live_server_url + "/login/")
            page.get_by_label("Username:", exact=True).fill("editor")
            page.get_by_label("Password:", exact=True).fill("test-password")
            page.get_by_role("button", name="Sign in", exact=True).click()
            page.goto(self.live_server_url + "/projects/EDIT/issues/new/")
            page.get_by_label("Title:", exact=True).fill("Markdown page")
            description = page.get_by_label("Description:", exact=True)
            description.fill("Result")
            description.evaluate("element => element.select()")
            page.get_by_role("button", name="Bold", exact=True).click()
            expect(description).to_have_value("**Result**")
            page.get_by_role("button", name="backend", exact=True).click()
            expect(page.get_by_label("Tags:", exact=True)).to_have_value("backend")
            page.get_by_role("button", name="Create issue", exact=True).click()
            task_url = page.url
            expect(page.locator(".description strong")).to_have_text("Result")
            expect(page.locator(".task-title")).to_have_text("Markdown page")
            page.get_by_role("button", name="Edit issue", exact=True).click()
            expect(page).to_have_url(task_url)
            expect(page.locator(".task-title")).not_to_be_visible()
            expect(page.locator("header #id_title")).to_be_visible()
            page.get_by_label("Title:", exact=True).fill("Changed in place")
            page.get_by_role("button", name="Save changes", exact=True).click()
            expect(page.locator(".task-title")).to_have_text("Changed in place")
            expect(page.get_by_role("button", name="Stop watching", exact=True)).to_have_count(0)
            page.get_by_role("button", name="Watch task", exact=True).click()
            expect(page.get_by_role("button", name="Watch task", exact=True)).to_have_count(0)
            expect(page.get_by_role("button", name="Stop watching", exact=True)).to_be_visible()
            page.locator(".person-link").click()
            page.get_by_label("About me:", exact=True).fill("Team member")
            page.get_by_label("Avatar:", exact=True).set_input_files(
                {"name": "avatar.png", "mimeType": "image/png", "buffer": picture.getvalue()}
            )
            page.get_by_role("button", name="Save changes", exact=True).click()
            response = page.request.get(self.live_server_url + f"/people/{person.pk}/avatar/")
            self.assertEqual(response.headers["content-type"], "image/png")
            page.goto(self.live_server_url + "/notifications/")
            expect(page.locator('.primary-nav [aria-current="page"]')).to_have_text("Notifications")
            page.goto(self.live_server_url + "/projects/EDIT/statuses/")
            expect(page.locator('input[name="position"]')).to_have_count(0)
            page.locator(f"#status-{active.pk}").get_by_role(
                "button", name="Move left", exact=False
            ).click()
            expect(page.locator(".status-settings h2").first).to_have_text("Working")
            page.get_by_role("button", name="RU", exact=True).click()
            expect(page.locator("#status-create")).to_contain_text(
                "В эту колонку попадают результаты"
            )
            for width in (360, 768, 1280):
                page.set_viewport_size({"width": width, "height": 900})
                expect(page.locator("html")).to_have_js_property("scrollWidth", width)
            browser.close()
