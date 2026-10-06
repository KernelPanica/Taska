import os
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase

from taska.projects.models import Issue, IssueType, Membership, Project, Status


@skipUnless(os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run browser checks.")
class RelationsBrowserTests(StaticLiveServerTestCase):
    def test_hierarchy_blocking_edit_and_remove(self):
        from playwright.sync_api import expect, sync_playwright

        user = get_user_model().objects.create_user("lead", password="test-password")
        project = Project.objects.create(key="TREE", name="Tree")
        Membership.objects.create(project=project, user=user, role="manager")
        queue = Status.objects.create(project=project, name="Queue", category="queue")
        kind = IssueType.objects.create(project=project, name="Task")
        for i in range(4):
            Issue.objects.create(
                project=project, status=queue, issue_type=kind, title=f"Level {i + 1}"
            )
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
            page.goto(self.live_server_url + "/login/")
            page.get_by_label("Username:", exact=True).fill("lead")
            page.get_by_label("Password:", exact=True).fill("test-password")
            page.get_by_role("button", name="Sign in", exact=True).click()
            for number in range(1, 4):
                page.goto(self.live_server_url + f"/projects/TREE/issues/{number}/")
                page.locator("#relations summary").click()
                page.get_by_label("Find a task by ID or title", exact=True).fill(
                    f"TREE-{number + 1}"
                )
                page.get_by_role("button", name="Search", exact=True).click()
                page.locator("#link-kind").select_option("parent")
                page.get_by_role("button", name="Add relation", exact=True).click()
                expect(page.locator("#relations")).to_contain_text("Parent of")
            page.goto(self.live_server_url + "/projects/TREE/issues/1/")
            expect(page.locator("#relations progress")).to_have_attribute("max", "1")
            row = page.locator(".relation-card").first
            row.get_by_label("Relation type", exact=True).select_option("blocks")
            row.get_by_role("button", name="Save changes", exact=True).click()
            expect(row).to_contain_text("Blocks")
            row.locator(".relation-target").click()
            expect(page).to_have_url(self.live_server_url + "/projects/TREE/issues/2/")
            expect(page.locator("#relations")).to_contain_text("Blocked by")
            page.get_by_role("button", name="RU", exact=True).click()
            expect(page.locator("#relations")).to_contain_text("Заблокирована задачей")
            for width in (360, 768, 1280):
                page.set_viewport_size({"width": width, "height": 900})
                expect(page.locator("html")).to_have_js_property("scrollWidth", width)
            page.locator(".relation-card").filter(
                has=page.locator(".relation-target", has_text="TREE-1")
            ).get_by_role("button", name="Удалить связь", exact=True).click()
            expect(page.locator("#relations")).not_to_contain_text("TREE-1")
            page.goto(self.live_server_url + "/projects/TREE/issues/1/")
            expect(page.locator(".task-title")).to_have_text("Level 1")
            browser.close()
