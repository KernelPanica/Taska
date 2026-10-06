import os
from pathlib import Path
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase

from taska.projects.models import Board, IssueType, Membership, Project, Status


@skipUnless(os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run browser checks.")
class IssueBrowserTests(StaticLiveServerTestCase):
    def test_issue_lifecycle(self):
        from playwright.sync_api import expect, sync_playwright

        user = get_user_model().objects.create_user("writer", password="test-password")
        project = Project.objects.create(key="TASKA", name="Taska")
        Membership.objects.create(project=project, user=user, role="manager")
        Board.objects.create(project=project, name="Team board")
        queue = Status.objects.create(project=project, name="To do", category="queue")
        done = Status.objects.create(project=project, name="In progress", category="active")
        bug = IssueType.objects.create(project=project, name="Bug", icon="bug")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
            page.goto(self.live_server_url + "/login/")
            page.get_by_label("Username").fill("writer")
            page.get_by_label("Password").fill("test-password")
            page.get_by_role("button", name="Sign in", exact=True).click()
            page.goto(self.live_server_url + "/projects/TASKA/")
            page.get_by_role("link", name="Issue types", exact=True).click()
            page.get_by_label("Name:", exact=True).fill("Release")
            page.get_by_label("Icon:", exact=True).select_option("issue")
            page.get_by_role("button", name="Create issue type", exact=True).click()
            page.get_by_role("link", name="Back to board", exact=False).click()
            page.get_by_role("link", name="Create issue", exact=True).click()
            page.get_by_label("Title:", exact=True).fill(
                "Исправить ошибку " + "длинное название " * 8
            )
            page.get_by_label("Description:", exact=True).fill(
                "## Details\n\n**Safe Markdown**\n<script>alert('bad')</script>\n\n"
                + "Подробное описание результата работы. " * 600
                + "\n\n```\n"
                + "long-unbroken-text-" * 150
                + "\n```"
            )
            page.get_by_label("Issue type:", exact=True).select_option(str(bug.pk))
            page.get_by_label("Status:", exact=True).select_option(str(queue.pk))
            page.get_by_label("Priority:", exact=True).select_option("high")
            page.get_by_label("Estimate:", exact=True).fill("5")
            page.get_by_label("Start date:", exact=True).fill("2026-10-01")
            page.get_by_label("Due date:", exact=True).fill("2026-10-05")
            page.get_by_label("Tags:", exact=True).fill("backend, проверка")
            page.get_by_role("button", name="Preview description").click()
            expect(page.locator(".preview strong")).to_have_text("Safe Markdown")
            self.assertEqual(
                len(
                    page.request.get(self.live_server_url + "/api/projects/TASKA/issues/").json()[
                        "issues"
                    ]
                ),
                0,
            )
            page.get_by_role("button", name="Create issue", exact=True).click()
            expect(page.locator(".issue-detail")).to_contain_text("TASKA-1")
            page.set_viewport_size({"width": 360, "height": 900})
            expect(page.locator("html")).to_have_js_property("scrollWidth", 360)
            page.set_viewport_size({"width": 1280, "height": 900})
            task_url = page.url
            page.get_by_role("button", name="Edit issue", exact=True).click()
            expect(page).to_have_url(task_url)
            expect(
                page.locator(".primary-nav").get_by_role("link", name="Boards", exact=True)
            ).to_have_count(0)
            page.get_by_label("Title:", exact=True).fill("Исправленная ошибка")
            page.get_by_label("Status:", exact=True).select_option(str(done.pk))
            page.get_by_label("Issue type:", exact=True).select_option(label="Release")
            page.get_by_label("Description:", exact=True).fill("Updated **description**")
            page.get_by_label("Estimate:", exact=True).fill("8")
            page.get_by_label("Priority:", exact=True).select_option("urgent")
            page.get_by_label("Start date:", exact=True).fill("2026-10-02")
            page.get_by_label("Due date:", exact=True).fill("2026-10-06")
            page.get_by_label("Tags:", exact=True).fill("проверено")
            page.get_by_role("button", name="Save changes").click()
            page.reload()
            expect(page.get_by_role("heading", name="Исправленная ошибка")).to_be_visible()
            expect(page.locator(".issue-detail")).to_contain_text("проверено")
            expect(page.locator(".issue-detail")).to_contain_text("Release")
            expect(page.locator(".issue-detail")).to_contain_text("Urgent")
            expect(page.locator(".issue-detail strong")).to_have_text("description")
            page.get_by_role("button", name="RU", exact=True).click()
            for width in (360, 768, 1280, 1920):
                page.set_viewport_size({"width": width, "height": 900})
                expect(page.locator("html")).to_have_js_property("scrollWidth", width)
            Path("artifacts").mkdir(exist_ok=True)
            page.set_viewport_size({"width": 1280, "height": 900})
            page.screenshot(path="artifacts/checkpoint1-issue.png", full_page=True)
            page.get_by_role("button", name="Редактировать задачу", exact=True).click()
            page.set_viewport_size({"width": 360, "height": 900})
            expect(page.locator("html")).to_have_js_property("scrollWidth", 360)
            page.get_by_role("button", name="Сохранить изменения").click()
            page.get_by_role("link", name="К доске", exact=False).click()
            page.locator(".issue-card").click(position={"x": 12, "y": 12})
            expect(page.get_by_role("heading", name="Исправленная ошибка")).to_be_visible()
            page.get_by_role("link", name="Удалить задачу", exact=True).click()
            expect(page.get_by_role("heading", name="Удалить TASKA-1?")).to_be_visible()
            self.assertEqual(
                len(
                    page.request.get(self.live_server_url + "/api/projects/TASKA/issues/").json()[
                        "issues"
                    ]
                ),
                1,
            )
            page.get_by_role("button", name="Подтвердить удаление").click()
            self.assertEqual(
                len(
                    page.request.get(self.live_server_url + "/api/projects/TASKA/issues/").json()[
                        "issues"
                    ]
                ),
                0,
            )
            page.get_by_role("link", name="Создать задачу", exact=True).click()
            page.get_by_label("Название:", exact=True).fill("Следующая задача")
            page.get_by_role("button", name="Создать задачу", exact=True).click()
            expect(page.locator(".issue-detail")).to_contain_text("TASKA-2")
            browser.close()
