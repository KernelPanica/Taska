import os
import tempfile
from pathlib import Path
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import override_settings

from taska.projects.models import Issue, IssueType, Membership, Project, Status


@skipUnless(os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run browser checks.")
class CollaborationBrowserTests(StaticLiveServerTestCase):
    def test_team_review_and_private_files(self):
        from playwright.sync_api import expect, sync_playwright

        users = {}
        project = Project.objects.create(key="TEAM", name="Team project")
        for role in ("manager", "member", "observer"):
            users[role] = get_user_model().objects.create_user(
                role, email=f"{role}@example.test", password="test-password"
            )
            Membership.objects.create(project=project, user=users[role], role=role)
        second = get_user_model().objects.create_user(
            "second-assignee", email="second@example.test"
        )
        Membership.objects.create(project=project, user=second, role="member")
        queue = Status.objects.create(project=project, name="To do", category="queue")
        Status.objects.create(project=project, name="In progress", category="active")
        Status.objects.create(project=project, name="In review", category="active", is_review=True)
        Status.objects.create(project=project, name="Done", category="done")
        kind = IssueType.objects.create(project=project, name="Task")
        issue = Issue.objects.create(
            project=project, title="Deliver progress report", status=queue, issue_type=kind
        )
        issue_path = f"/projects/TEAM/issues/{issue.number}/"
        with (
            tempfile.TemporaryDirectory() as media,
            override_settings(MEDIA_ROOT=media),
            sync_playwright() as playwright,
        ):
            browser = playwright.chromium.launch()
            pages = {}
            for role in users:
                page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
                page.goto(self.live_server_url + "/login/")
                expect(page.locator(".sidebar")).to_have_count(0)
                page.get_by_label("Username:", exact=True).fill(role)
                page.get_by_label("Password:", exact=True).fill("test-password")
                page.get_by_role("button", name="Sign in", exact=True).click()
                page.goto(self.live_server_url + issue_path)
                pages[role] = page
            pm, member, observer = (pages[role] for role in ("manager", "member", "observer"))
            pm.get_by_text("Manage participants", exact=True).click()
            pm.get_by_label("Assignees:", exact=True).select_option(
                [str(users["member"].pk), str(second.pk)]
            )
            pm.get_by_label("Customers:", exact=True).select_option(str(users["member"].pk))
            pm.get_by_label("Watchers:", exact=True).select_option(str(users["observer"].pk))
            pm.get_by_label("Search people", exact=True).fill("observer")
            expect(pm.get_by_label("Assignees:", exact=True)).to_have_values(
                [str(users["member"].pk), str(second.pk)]
            )
            pm.get_by_role("button", name="Save changes", exact=True).click()
            member.reload()
            member.get_by_role("button", name="Start or update work", exact=True).click()
            member.get_by_label("Progress, links and reports:", exact=True).fill(
                "Completed **report** https://git.example/commit/123"
            )
            member.get_by_label("Files and reports", exact=True).set_input_files(
                {"name": "report.txt", "mimeType": "text/plain", "buffer": b"Progress evidence"}
            )
            member.get_by_role("button", name="Submit for review", exact=True).click()
            expect(member.get_by_text("Pending review", exact=True)).to_be_visible()
            expect(member.get_by_role("button", name="Edit issue", exact=True)).to_have_count(0)
            download_url = member.get_by_role("link", name="report.txt", exact=True).get_attribute(
                "href"
            )
            anonymous = browser.new_context()
            response = anonymous.request.get(self.live_server_url + download_url, max_redirects=0)
            self.assertEqual(response.status, 302)
            with member.expect_download() as download:
                member.get_by_role("link", name="report.txt", exact=True).click()
            self.assertEqual(download.value.suggested_filename, "report.txt")
            observer.reload()
            observer.get_by_label("Comment", exact=True).fill("Report checked")
            observer.get_by_role("button", name="Add comment", exact=True).click()
            expect(
                observer.locator(".markdown p").filter(has_text="Report checked")
            ).to_be_visible()
            pm.reload()
            pm.get_by_role("button", name="Approve and complete", exact=True).click()
            expect(pm.get_by_text("Approved", exact=False).first).to_be_visible()
            observer.goto(self.live_server_url + "/notifications/")
            expect(observer.get_by_role("link", name="TEAM-1 · Review approved")).to_be_visible()
            pm.goto(self.live_server_url + "/projects/TEAM/statuses/")
            pm.locator("#status-create").get_by_label("Name:", exact=True).fill("Blocked")
            pm.locator("#status-create").get_by_label("Category:", exact=True).select_option(
                "active"
            )
            pm.get_by_role("button", name="Save changes", exact=True).click()
            pm.goto(self.live_server_url + "/projects/TEAM/")
            expect(pm.get_by_role("heading", name="Blocked", exact=True)).to_be_visible()
            pm.goto(self.live_server_url + "/projects/TEAM/team/")
            pm.get_by_label("Email:", exact=True).fill("invited@example.test")
            pm.get_by_role("button", name="Create invitation", exact=True).click()
            expect(pm.get_by_label("Copy this invitation link now", exact=True)).to_be_visible()
            pm.goto(self.live_server_url + issue_path)
            pm.get_by_role("button", name="RU", exact=True).click()
            expect(pm.get_by_role("heading", name="Результаты и проверка")).to_be_visible()
            expect(pm.locator("#reopen-status option")).to_have_text(["В работе", "Blocked"])
            for width in (360, 768, 1280, 1920):
                pm.set_viewport_size({"width": width, "height": 900})
                expect(pm.locator("html")).to_have_js_property("scrollWidth", width)
            pm.set_viewport_size({"width": 1280, "height": 900})
            Path("artifacts").mkdir(exist_ok=True)
            pm.screenshot(path="artifacts/checkpoint2-review.png", full_page=True)
            browser.close()
