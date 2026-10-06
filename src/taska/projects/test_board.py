from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .models import Issue, IssueType, Membership, Project, Status, Submission, Tag


class BoardTests(TestCase):
    def setUp(self):
        self.pm = get_user_model().objects.create_user("pm")
        self.member = get_user_model().objects.create_user("member")
        self.observer = get_user_model().objects.create_user("observer")
        self.project = Project.objects.create(key="BOARD", name="Board")
        for user, role in [
            (self.pm, "manager"),
            (self.member, "member"),
            (self.observer, "observer"),
        ]:
            Membership.objects.create(project=self.project, user=user, role=role)
        self.queue = Status.objects.create(project=self.project, name="Queue", category="queue")
        self.active = Status.objects.create(project=self.project, name="Working", category="active")
        self.review = Status.objects.create(
            project=self.project, name="Review", category="active", is_review=True
        )
        self.done = Status.objects.create(project=self.project, name="Done", category="done")
        self.kind = IssueType.objects.create(project=self.project, name="Task")
        self.issue = self.create("First")
        self.second = self.create("Second")
        self.issue.assignees.add(self.member)
        self.client.force_login(self.pm)
        self.url = "/projects/BOARD/board/action/"

    def create(self, title):
        return Issue.objects.create(
            project=self.project, status=self.queue, issue_type=self.kind, title=title
        )

    def payload(self, **extra):
        self.project.refresh_from_db()
        self.issue.refresh_from_db()
        return {
            "board_version": self.project.version,
            "version": self.issue.version,
            "issue": self.issue.pk,
            "status": self.queue.pk,
            **extra,
        }

    def test_order_and_conflicts_are_atomic(self):
        stale = self.payload(direction="down")
        self.assertEqual(self.client.post(self.url, stale).status_code, 302)
        self.assertEqual(
            list(self.project.issues.order_by("position").values_list("title", flat=True)),
            ["Second", "First"],
        )
        self.assertEqual(
            self.client.post(self.url, stale, HTTP_ACCEPT="application/json").status_code, 409
        )
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.active.pk)).status_code, 302
        )
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.status, self.active)
        before_version = self.project.version
        response = self.client.post(self.url, self.payload(status=self.queue.pk, before=999999))
        self.assertEqual(response.status_code, 400)
        self.issue.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(self.issue.status, self.active)
        self.assertEqual(self.project.version, before_version + 1)

    def test_task_controls_append_to_destination(self):
        for issue in (self.second, self.issue):
            response = self.client.post(
                f"/projects/BOARD/issues/{issue.number}/action/",
                {"action": "start", "version": issue.version, "status": self.active.pk},
            )
            self.assertEqual(response.status_code, 302)
        self.assertEqual(
            list(
                self.project.issues.filter(status=self.active)
                .order_by("position")
                .values_list("pk", flat=True)
            ),
            [self.second.pk, self.issue.pk],
        )

    def test_member_review_and_unrestricted_pm_moves(self):
        self.client.force_login(self.member)
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.active.pk)).status_code, 302
        )
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.review.pk)).status_code, 400
        )
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.done.pk)).status_code, 400
        )
        self.issue.status = self.review
        self.issue.save()
        submission = Submission.objects.create(
            issue=self.issue, author=self.member, body="Evidence", issue_version=self.issue.version
        )
        self.assertEqual(
            self.client.post(
                self.url, self.payload(status=self.done.pk, confirm_review="yes")
            ).status_code,
            403,
        )
        self.client.force_login(self.pm)
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.done.pk)).status_code, 302
        )
        submission.refresh_from_db()
        self.assertEqual(submission.decision, "approved")
        self.assertEqual(
            self.client.post(self.url, self.payload(status=self.active.pk)).status_code, 302
        )

    def test_access_and_rename(self):
        self.client.logout()
        self.assertEqual(self.client.post(self.url, self.payload()).status_code, 302)
        self.client.force_login(self.observer)
        self.assertEqual(self.client.post(self.url, self.payload()).status_code, 403)
        self.client.force_login(self.member)
        data = self.payload(issue=self.second.pk)
        self.assertEqual(self.client.post(self.url, data).status_code, 403)
        self.assertEqual(
            self.client.post(self.url, self.payload(action="rename", name="Changed")).status_code,
            403,
        )
        self.client.force_login(self.pm)
        data = self.payload(action="rename", name="Changed")
        self.assertEqual(self.client.post(self.url, data).status_code, 302)
        self.assertEqual(self.client.post(self.url, data).status_code, 409)
        self.queue.refresh_from_db()
        self.assertEqual(self.queue.name, "Changed")
        self.assertEqual(
            self.client.post(self.url, self.payload(action="rename", name="Working")).status_code,
            400,
        )
        other = Project.objects.create(key="OTHER", name="Other")
        status = Status.objects.create(project=other, name="Other", category="active")
        self.assertEqual(
            self.client.post(self.url, self.payload(status=status.pk)).status_code, 404
        )

    def test_hundred_cards_filters_and_overdue(self):
        for number in range(98):
            self.create(f"Task {number}")
        self.issue.due_date = timezone.localdate() - timedelta(days=1)
        self.issue.save()
        tag = Tag.objects.create(project=self.project, name="Backend")
        self.issue.tags.add(tag)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get("/projects/BOARD/")
        self.assertEqual(response.status_code, 200)
        self.assertLess(len(queries), 20)
        self.assertContains(response, 'class="issue-card"', count=100)
        self.assertContains(response, "Overdue")
        for query in [f"tag={tag.pk}", f"assignee={self.member.pk}"]:
            response = self.client.get("/projects/BOARD/?" + query)
            self.assertContains(response, 'class="issue-card"', count=1)

    def test_pm_can_remove_stock_columns_and_preserve_tasks(self):
        url = "/projects/BOARD/statuses/"
        for status in (self.review, self.done):
            self.project.refresh_from_db()
            response = self.client.post(
                url, {"version": self.project.version, "action": "delete", "status_id": status.pk}
            )
            self.assertEqual(response.status_code, 302)
            self.assertFalse(Status.objects.filter(pk=status.pk).exists())
        self.project.refresh_from_db()
        response = self.client.post(
            url,
            {
                "version": self.project.version,
                "name": "Custom queue",
                "category": "queue",
                "position": 4,
            },
        )
        self.assertEqual(response.status_code, 302)
        replacement = self.project.statuses.get(name="Custom queue")
        self.project.refresh_from_db()
        data = {"version": self.project.version, "action": "delete", "status_id": self.queue.pk}
        self.assertEqual(self.client.post(url, data).status_code, 400)
        self.assertEqual(self.project.issues.count(), 2)
        self.assertEqual(
            self.client.post(url, {**data, "replacement": replacement.pk}).status_code, 302
        )
        self.assertEqual(replacement.issues.count(), 2)
        self.assertFalse(Status.objects.filter(pk=self.queue.pk).exists())
        self.client.force_login(self.member)
        self.project.refresh_from_db()
        self.assertEqual(
            self.client.post(
                url,
                {"version": self.project.version, "action": "delete", "status_id": self.active.pk},
            ).status_code,
            403,
        )

    def test_inline_editor_keeps_markdown_and_conflicts_on_task_page(self):
        url = f"/projects/BOARD/issues/{self.issue.number}/"
        response = self.client.get(url)
        self.assertContains(response, 'class="task-document"')
        self.assertNotContains(response, 'href="/boards/"')
        data = {
            "title": "Page title",
            "description": "## Result\n\n**Evidence**<script>alert(1)</script>",
            "status": self.queue.pk,
            "issue_type": self.kind.pk,
            "expected_version": self.issue.version,
        }
        response = self.client.post(url, {**data, "action": "preview"})
        self.assertContains(response, "<strong>Evidence</strong>")
        self.assertNotContains(response, "<script>alert(1)</script>")
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.title, "First")
        self.assertRedirects(self.client.post(url, data), url)
        response = self.client.post(url, {**data, "description": "Keep my unsaved text"})
        self.assertEqual(response.status_code, 409)
        self.assertContains(response, "Keep my unsaved text", status_code=409)
        self.assertContains(response, 'class="inline-editor" open', status_code=409)
        self.client.force_login(self.observer)
        self.assertEqual(self.client.post(url, data).status_code, 403)
