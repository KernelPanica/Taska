import io
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from .models import Issue, IssueType, Membership, Project, Status


class FoundationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.member = get_user_model().objects.create_user("member", password="test-password")
        cls.observer = get_user_model().objects.create_user("observer")
        cls.outsider = get_user_model().objects.create_user("outsider")
        cls.admin = get_user_model().objects.create_superuser("admin", password="test-password")
        cls.project = Project.objects.create(key="TASKA", name="Taska")
        cls.hidden = Project.objects.create(key="PRIVATE", name="Secret project")
        Membership.objects.create(project=cls.project, user=cls.member)
        Membership.objects.create(project=cls.project, user=cls.observer, role="observer")
        cls.status = Status.objects.create(project=cls.project, name="To do", category="queue")
        cls.kind = IssueType.objects.create(project=cls.project, name="Task")

    def test_login_project_empty_board_and_api(self):
        response = self.client.post(
            reverse("login"), {"username": "member", "password": "test-password"}, follow=True
        )
        self.assertContains(response, "Taska")
        self.assertNotContains(response, "Secret project")
        self.assertContains(self.client.get("/projects/TASKA/"), "No issues in this status")
        self.assertEqual(self.client.get("/api/projects/TASKA/issues/").json(), {"issues": []})
        self.assertEqual(
            self.client.get("/api/projects/TASKA/").json()["project"]["statuses"],
            [{"name": "To do", "category": "queue"}],
        )
        self.assertEqual(len(self.client.get("/api/projects/").json()["projects"]), 1)

    def test_permissions_on_every_read_path_and_no_writes(self):
        for user in (self.member, self.observer):
            self.client.force_login(user)
            self.assertEqual(self.client.get("/projects/TASKA/").status_code, 200)
            self.assertEqual(self.client.get("/projects/PRIVATE/").status_code, 404)
            self.assertEqual(self.client.get("/api/projects/PRIVATE/issues/").status_code, 404)
            self.assertEqual(
                self.client.post("/api/projects/TASKA/issues/", {"title": "Not yet"}).status_code,
                405,
            )
            self.assertEqual(self.client.get("/admin/projects/project/").status_code, 302)
        self.client.force_login(self.outsider)
        self.assertEqual(self.client.get("/api/projects/").json(), {"projects": []})
        self.assertEqual(self.client.get("/projects/TASKA/").status_code, 404)
        self.client.force_login(self.admin)
        self.assertEqual(len(self.client.get("/api/projects/").json()["projects"]), 2)
        self.assertEqual(self.client.get("/admin/projects/project/").status_code, 200)

    def test_api_errors_share_an_envelope(self):
        checks = [
            ("/api/projects/", 401, "authentication_required"),
            ("/api/missing/", 401, "authentication_required"),
        ]
        for url, status, code in checks:
            response = self.client.get(url)
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json()["error"]["code"], code)
            self.assertTrue(response.json()["error"]["message"])
        self.client.force_login(self.member)
        response = self.client.post("/api/projects/")
        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.headers["Allow"], "GET")
        self.assertEqual(response.json()["error"]["code"], "method_not_allowed")
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.member)
        response = csrf_client.post("/api/projects/")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "permission_denied")
        with patch(
            "taska.projects.views.visible_projects", side_effect=RuntimeError("private details")
        ):
            self.client.raise_request_exception = False
            with self.assertLogs("django.request", level="ERROR"):
                response = self.client.get("/api/projects/")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["error"]["code"], "server_error")
        self.assertNotIn("private details", response.content.decode())

    def test_issue_scope_validation_and_safe_rendering(self):
        issue = Issue.objects.create(
            project=self.project,
            number=1,
            title="<script>alert(1)</script>",
            status=self.status,
            issue_type=self.kind,
        )
        foreign_status = Status.objects.create(project=self.hidden, name="Secret", category="queue")
        issue.status = foreign_status
        with self.assertRaises(ValidationError):
            issue.save()
        self.status.project = self.hidden
        with self.assertRaises(ValidationError):
            self.status.full_clean()
        self.kind.project = self.hidden
        with self.assertRaises(ValidationError):
            self.kind.full_clean()
        self.client.force_login(self.member)
        self.assertContains(self.client.get("/projects/TASKA/issues/1/"), "&lt;script&gt;")
        self.client.force_login(self.outsider)
        self.assertEqual(self.client.get("/projects/TASKA/issues/1/").status_code, 404)

    @override_settings(DEBUG=True)
    def test_demo_is_repeatable_and_empty_project_stays_empty(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"TASKA_DEMO_MODE": "true"}),
        ):
            path = Path(directory) / "credentials.json"
            for _ in range(2):
                call_command(
                    "seed_demo", credentials_file=str(path), with_issues=True, stdout=io.StringIO()
                )
            self.assertEqual(Project.objects.filter(key="TASKA").count(), 1)
            self.assertEqual(Issue.objects.filter(project__key="TASKA").count(), 0)
            self.assertEqual(Issue.objects.filter(project__key="SAMPLE").count(), 3)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            credentials = json.loads(path.read_text())
            self.assertTrue(
                self.client.login(username="demo-member", password=credentials["demo-member"])
            )
            Issue.objects.filter(project__key="SAMPLE", number=1).delete()
            call_command(
                "seed_demo", credentials_file=str(path), with_issues=True, stdout=io.StringIO()
            )
            self.assertFalse(Issue.objects.filter(project__key="SAMPLE", number=1).exists())


class IssueWorkflowTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("writer")
        self.project = Project.objects.create(key="TASKA", name="Taska")
        Membership.objects.create(project=self.project, user=self.user, role="manager")
        self.queue = Status.objects.create(project=self.project, name="To do", category="queue")
        self.done = Status.objects.create(
            project=self.project, name="In progress", category="active"
        )
        self.kind = IssueType.objects.create(project=self.project, name="Bug")
        self.client.force_login(self.user)

    def test_create_preview_edit_delete_and_non_reused_ids(self):
        data = {
            "title": "Fix a bug",
            "description": "**Bold** <script>alert(1)</script> [unsafe](javascript:alert(1))",
            "action": "preview",
        }
        response = self.client.post("/projects/TASKA/issues/new/", data)
        self.assertContains(response, "<strong>Bold</strong>")
        self.assertNotContains(response, "<script>alert(1)</script>")
        self.assertNotContains(response, 'href="javascript:')
        self.assertEqual(Issue.objects.count(), 0)
        data.update(
            action="save",
            estimate=3,
            priority="high",
            start_date="2026-10-01",
            due_date="2026-10-02",
            tag_names="bug, urgent",
        )
        self.assertRedirects(
            self.client.post("/projects/TASKA/issues/new/", data), "/projects/TASKA/issues/1/"
        )
        issue = Issue.objects.get()
        self.assertEqual(issue.reference, "TASKA-1")
        self.assertEqual(issue.tags.count(), 2)
        self.assertContains(self.client.get("/projects/TASKA/issues/1/"), "High")
        edit = "/projects/TASKA/issues/1/edit/"
        self.assertContains(self.client.get(edit, follow=True), 'value="2026-10-01"')
        data.update(
            title="Fixed", status=self.done.pk, expected_version=1, tag_names="urgent, reviewed"
        )
        self.assertRedirects(self.client.post(edit, data), "/projects/TASKA/issues/1/")
        issue.refresh_from_db()
        self.assertEqual((issue.title, issue.status_id, issue.version), ("Fixed", self.done.pk, 2))
        self.assertEqual(set(issue.tags.values_list("name", flat=True)), {"urgent", "reviewed"})
        self.assertEqual(self.client.post(edit, data).status_code, 409)
        self.assertEqual(self.client.get("/projects/TASKA/issues/1/delete/").status_code, 200)
        self.assertTrue(Issue.objects.exists())
        self.assertEqual(
            self.client.post(
                "/projects/TASKA/issues/1/delete/", {"confirm": "yes", "version": 1}
            ).status_code,
            409,
        )
        self.assertRedirects(
            self.client.post("/projects/TASKA/issues/1/delete/", {"confirm": "yes", "version": 2}),
            "/projects/TASKA/",
        )
        self.assertFalse(Issue.objects.exists())
        self.assertRedirects(
            self.client.post("/projects/TASKA/issues/new/", {"title": "Next"}),
            "/projects/TASKA/issues/2/",
        )
        with self.assertRaises(ValidationError):
            Issue.objects.create(
                project=self.project,
                number=1,
                title="Reused",
                status=self.queue,
                issue_type=self.kind,
            )

    def test_validation_permissions_types_and_csrf(self):
        url = "/projects/TASKA/issues/new/"
        for values in (
            {"title": ""},
            {"title": "Bad dates", "start_date": "2026-10-02", "due_date": "2026-10-01"},
            {"title": "Bad estimate", "estimate": "1.5"},
            {"title": "Bad estimate", "estimate": -1},
            {"title": "Invalid tag", "tag_names": "x" * 41},
        ):
            self.assertEqual(self.client.post(url, values).status_code, 400)
        foreign = Project.objects.create(key="OTHER", name="Other")
        foreign_status = Status.objects.create(project=foreign, name="Private", category="queue")
        self.assertEqual(
            self.client.post(
                url, {"title": "Cross-project", "status": foreign_status.pk}
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/projects/TASKA/types/", {"name": "Custom", "color": "red;bad", "icon": "issue"}
            ).status_code,
            400,
        )
        self.assertRedirects(
            self.client.post(
                "/projects/TASKA/types/", {"name": "Custom", "color": "#abcdef", "icon": "bug"}
            ),
            "/projects/TASKA/types/",
        )
        self.assertEqual(
            self.client.post(
                "/projects/TASKA/types/", {"name": "Custom", "color": "#abcdef", "icon": "bug"}
            ).status_code,
            400,
        )
        custom = self.project.issue_types.get(name="Custom")
        self.client.post(url, {"title": "Custom issue", "issue_type": custom.pk})
        self.assertEqual(Issue.objects.get().issue_type, custom)
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        self.assertEqual(csrf_client.post(url, {"title": "No CSRF"}).status_code, 403)
        Membership.objects.filter(user=self.user).update(role="observer")
        for endpoint in (
            url,
            "/projects/TASKA/issues/1/edit/",
            "/projects/TASKA/issues/1/delete/",
            "/projects/TASKA/types/",
        ):
            self.assertEqual(self.client.get(endpoint).status_code, 403)
            self.assertEqual(self.client.post(endpoint, {"title": "Denied"}).status_code, 403)
        self.assertNotContains(self.client.get("/projects/TASKA/"), "Create issue")
        self.assertTrue(Issue.objects.exists())
