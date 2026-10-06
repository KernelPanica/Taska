import os
from datetime import timedelta
from pathlib import Path
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.utils import timezone

from taska.projects.models import Issue, IssueType, Membership, Project, Status, Tag


@skipUnless(os.environ.get("RUN_BROWSER") == "1", "Set RUN_BROWSER=1 to run browser checks.")
class BoardBrowserTests(StaticLiveServerTestCase):
    def test_board_drag_controls_filters_conflicts_and_scale(self):
        from playwright.sync_api import expect, sync_playwright

        user = get_user_model().objects.create_user("board-pm", password="test-password")
        project = Project.objects.create(key="BOARD", name="Board")
        Membership.objects.create(project=project, user=user, role="manager")
        queue = Status.objects.create(project=project, name="To do", category="queue")
        active = Status.objects.create(project=project, name="Working", category="active")
        review = Status.objects.create(
            project=project, name="Review", category="active", is_review=True
        )
        kind = IssueType.objects.create(project=project, name="Task")
        for index in range(100):
            issue = Issue.objects.create(
                project=project,
                status=queue,
                issue_type=kind,
                title=f"Task {index}",
                due_date=timezone.localdate() - timedelta(days=1),
            )
            if index == 0:
                first = issue
                issue.assignees.add(user)
                issue.tags.add(Tag.objects.create(project=project, name="Backend"))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
            page = context.new_page()
            page.goto(self.live_server_url + "/login/")
            page.get_by_label("Username:", exact=True).fill("board-pm")
            page.get_by_label("Password:", exact=True).fill("test-password")
            page.get_by_role("button", name="Sign in", exact=True).click()
            url = self.live_server_url + "/projects/BOARD/"
            page.goto(url)
            expect(page.locator(".issue-card")).to_have_count(100)
            expect(page.locator(".overdue").first).to_have_text("Overdue")
            stale = context.new_page()
            stale.goto(url)
            card = page.locator(f'[data-issue="{first.pk}"]')
            column = page.locator(f'[data-status="{active.pk}"]')
            page.evaluate("window.boardDocumentMarker = 42")
            # Start on the card background, outside its native links and controls.
            card.drag_to(column.locator(".column-content"), source_position={"x": 8, "y": 8})
            expect(column.locator(".issue-card")).to_have_count(1)
            self.assertEqual(page.evaluate("window.boardDocumentMarker"), 42)
            expect(page).to_have_url(url)
            card.dispatch_event("click", {"detail": 1})
            expect(page).to_have_url(url)
            page.reload()
            expect(column.locator(".issue-card")).to_have_count(1)
            old = stale.locator(f'[data-issue="{first.pk}"]')
            old.drag_to(
                stale.locator(f'[data-status="{active.pk}"] .column-content'),
                source_position={"x": 8, "y": 8},
            )
            expect(stale.locator("#board-feedback")).to_contain_text("The board changed")
            # Interactive links must not initiate card dragging.
            card.get_by_role("link", name="Backend", exact=True).drag_to(
                page.locator(f'[data-status="{queue.pk}"] .column-header')
            )
            expect(column.locator(".issue-card")).to_have_count(1)
            # Reorder within a column with real drag-and-drop, then reload.
            queue_cards = page.locator(f'[data-status="{queue.pk}"] .issue-card')
            moved_id = queue_cards.nth(1).get_attribute("data-issue")
            queue_cards.nth(1).drag_to(queue_cards.first, source_position={"x": 8, "y": 8})
            expect(queue_cards.first).to_have_attribute("data-issue", moved_id)
            page.reload()
            expect(queue_cards.first).to_have_attribute("data-issue", moved_id)
            card.get_by_role("link", name="Backend", exact=True).click()
            expect(page.locator(".issue-card")).to_have_count(1)
            page.get_by_role("link", name="Clear filters").click()
            card.get_by_role("link", name="board-pm", exact=True).click()
            expect(page.locator(".issue-card")).to_have_count(1)
            page.goto(url)
            column.get_by_text("Rename column", exact=True).click()
            column.get_by_label("Name", exact=True).fill("Development")
            column.get_by_role("button", name="Save", exact=True).click()
            expect(column.get_by_role("heading", name="Development")).to_be_visible()
            card.get_by_text("Move task", exact=True).first.click()
            card.get_by_label("Status", exact=True).select_option(str(queue.pk))
            card.get_by_role("button", name="Move task", exact=True).click()
            queue_cards = page.locator(f'[data-status="{queue.pk}"] .issue-card')
            expect(queue_cards.last).to_have_attribute("data-issue", str(first.pk))
            card.get_by_text("Move task", exact=True).first.click()
            card.get_by_role("button", name="Move up", exact=True).click()
            expect(queue_cards.nth(98)).to_have_attribute("data-issue", str(first.pk))
            page.reload()
            expect(queue_cards.nth(98)).to_have_attribute("data-issue", str(first.pk))
            page.get_by_role("button", name="RU", exact=True).click()
            for width in (360, 768, 1280, 1920):
                page.set_viewport_size({"width": width, "height": 900})
                expect(page.locator("html")).to_have_js_property("scrollWidth", width)
            expect(page.locator(".overdue").first).to_have_text("Просрочено")
            page.set_viewport_size({"width": 1280, "height": 900})
            Path("artifacts").mkdir(exist_ok=True)
            page.screenshot(path="artifacts/checkpoint3-board.png")
            # A PM can move into review directly, without dialogs or navigation.
            moved = queue_cards.first.get_attribute("data-issue")
            task_url = self.live_server_url + queue_cards.first.get_attribute("data-url")
            dialogs = []
            page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            queue_cards.first.drag_to(
                page.locator(f'[data-status="{review.pk}"] .column-content'),
                source_position={"x": 8, "y": 8},
            )
            expect(page).to_have_url(url)
            moved_card = page.locator(f'[data-status="{review.pk}"] [data-issue="{moved}"]')
            expect(moved_card).to_have_count(1)
            self.assertEqual(dialogs, [])
            moved_card.click(position={"x": 8, "y": 8})
            expect(page).to_have_url(task_url)
            browser.close()
