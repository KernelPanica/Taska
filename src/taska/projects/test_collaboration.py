import hashlib
import io
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .forms import IssueForm
from .models import (
    AssignmentRequest,
    Attachment,
    Comment,
    Invitation,
    Issue,
    IssueType,
    Membership,
    Notification,
    Outbox,
    Project,
    Status,
    Submission,
)


class CollaborationTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.media = override_settings(MEDIA_ROOT=self.directory.name)
        self.media.enable()
        self.addCleanup(self.media.disable)
        User = get_user_model()
        self.pm = User.objects.create_user("pm", email="pm@example.test")
        self.member = User.objects.create_user("member", email="member@example.test")
        self.other = User.objects.create_user("other", email="other@example.test")
        self.observer = User.objects.create_user("observer", email="observer@example.test")
        self.outsider = User.objects.create_user("outsider", email="outside@example.test")
        self.project = Project.objects.create(key="TEAM", name="Private team")
        for user, role in [
            (self.pm, "manager"),
            (self.member, "member"),
            (self.other, "member"),
            (self.observer, "observer"),
        ]:
            Membership.objects.create(project=self.project, user=user, role=role)
        self.queue = Status.objects.create(project=self.project, name="To do", category="queue")
        self.active = Status.objects.create(project=self.project, name="Working", category="active")
        self.review = Status.objects.create(
            project=self.project, name="Review", category="active", is_review=True
        )
        self.done = Status.objects.create(project=self.project, name="Done", category="done")
        self.kind = IssueType.objects.create(project=self.project, name="Task")
        self.issue = Issue.objects.create(
            project=self.project, title="Confidential task", status=self.queue, issue_type=self.kind
        )
        self.issue.assignees.add(self.member)
        self.issue.watchers.add(self.observer)
        self.url = f"/projects/TEAM/issues/{self.issue.number}/"
        self.client.force_login(self.pm)

    def action(self, user, action, **values):
        self.client.force_login(user)
        self.issue.refresh_from_db()
        return self.client.post(
            self.url + "action/", {"version": self.issue.version, "action": action, **values}
        )

    def project_post(self, endpoint, **values):
        self.project.refresh_from_db()
        return self.client.post(
            f"/projects/TEAM/{endpoint}/", {"version": self.project.version, **values}
        )

    def test_default_deny_and_login_isolated(self):
        self.client.logout()
        for url in [
            "/",
            "/roadmap/",
            "/missing/",
            "/projects/",
            self.url,
            "/attachments/1/",
            "/notifications/",
            "/admin/",
        ]:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 302, url)
            self.assertNotIn(b"Confidential task", response.content)
        self.assertEqual(self.client.get("/api/missing/").status_code, 401)
        response = self.client.get("/login/")
        self.assertNotContains(response, "sidebar")
        self.assertNotContains(response, "Private team")
        self.assertNotContains(response, "possibility")
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.client.force_login(self.outsider)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.get("/projects/TEAM/team/").status_code, 404)
        self.assertEqual(self.client.get("/api/projects/TEAM/issues/").status_code, 404)

    def test_review_files_comments_notifications_and_stale_approval(self):
        self.assertEqual(self.action(self.member, "start", status=self.active.pk).status_code, 302)
        upload = SimpleUploadedFile(
            "report.html", b"<script>alert(1)</script>", content_type="text/html"
        )
        self.assertEqual(
            self.action(
                self.member,
                "submit",
                body="**Progress** https://git.example/commit/123",
                files=[upload],
            ).status_code,
            302,
        )
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.status, self.review)
        submitted_version = self.issue.version
        self.assertEqual(self.client.get(self.url + "edit/").status_code, 403)
        self.assertEqual(self.action(self.member, "approve", status=self.done.pk).status_code, 403)
        attachment = Attachment.objects.get()
        response = self.client.get(f"/attachments/{attachment.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), b"<script>alert(1)</script>")
        self.assertTrue(response["Content-Disposition"].startswith("attachment;"))
        self.assertEqual(response["Content-Type"], "application/octet-stream")
        self.assertEqual(
            self.action(
                self.observer, "comment", body="Reviewed **report** <script>bad()</script>"
            ).status_code,
            302,
        )
        self.assertNotContains(self.client.get(self.url), "<script>bad()</script>")
        self.client.force_login(self.pm)
        self.assertEqual(
            self.client.post(
                self.url + "action/",
                {"action": "approve", "status": self.done.pk, "version": submitted_version},
            ).status_code,
            409,
        )
        self.assertEqual(self.action(self.pm, "return", status=self.active.pk).status_code, 302)
        self.assertEqual(Submission.objects.get().decision, "returned")
        self.assertEqual(self.action(self.member, "submit", body="Fixed report").status_code, 302)
        self.assertEqual(self.action(self.pm, "approve", status=self.done.pk).status_code, 302)
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.status, self.done)
        self.assertEqual(Submission.objects.filter(decision="approved").count(), 1)
        self.assertTrue(Notification.objects.filter(user=self.observer, kind="approved").exists())
        self.assertFalse(Outbox.objects.exists())
        self.client.force_login(self.member)
        self.assertNotContains(self.client.get("/"), self.issue.title)
        self.assertContains(self.client.get("/?status=done"), self.issue.title)
        self.assertEqual(self.action(self.member, "reopen", status=self.active.pk).status_code, 403)
        self.client.force_login(self.outsider)
        self.assertEqual(self.client.get(f"/attachments/{attachment.pk}/").status_code, 404)

    def test_permissions_assignment_requests_and_participants(self):
        other_project = Project.objects.create(key="ELSE", name="Elsewhere")
        Membership.objects.create(project=other_project, user=self.member, role="observer")
        self.client.force_login(self.member)
        self.assertEqual(self.client.get("/projects/TEAM/issues/new/").status_code, 403)
        self.assertEqual(self.client.get(self.url + "delete/").status_code, 403)
        self.assertEqual(self.action(self.other, "start", status=self.active.pk).status_code, 403)
        self.assertEqual(
            self.action(self.member, "participants", assignees=[self.other.pk]).status_code, 403
        )
        self.assertEqual(self.action(self.other, "request_assignment").status_code, 302)
        self.assertEqual(self.action(self.other, "request_assignment").status_code, 302)
        self.assertEqual(AssignmentRequest.objects.count(), 1)
        item = AssignmentRequest.objects.get()
        self.assertEqual(
            self.action(self.pm, "assignment_approve", request_id=item.pk).status_code, 302
        )
        self.assertTrue(self.issue.assignees.filter(pk=self.other.pk).exists())
        self.assertEqual(
            self.action(
                self.pm,
                "participants",
                assignees=[self.member.pk, self.other.pk],
                customers=[self.member.pk],
                watchers=[self.observer.pk, self.member.pk],
            ).status_code,
            302,
        )
        self.assertEqual(self.issue.assignees.count(), 2)
        self.assertEqual(
            self.action(self.pm, "participants", assignees=[self.outsider.pk]).status_code, 400
        )
        self.assertEqual(self.issue.assignees.count(), 2)
        self.assertEqual(
            self.action(self.pm, "participants", assignees=[self.observer.pk]).status_code, 400
        )
        self.assertEqual(self.action(self.observer, "submit", body="No").status_code, 403)
        self.assertEqual(self.action(self.member, "start", status="invalid").status_code, 400)

    def test_completion_cannot_bypass_review_and_csrf(self):
        self.client.force_login(self.pm)
        self.assertEqual(
            self.client.post(
                self.url + "edit/",
                {"title": "Bypass", "status": self.done.pk, "expected_version": self.issue.version},
            ).status_code,
            400,
        )
        self.assertEqual(self.action(self.pm, "approve", status=self.done.pk).status_code, 400)
        self.assertEqual(self.action(self.member, "start", status=self.review.pk).status_code, 403)
        self.assertEqual(self.action(self.member, "start", status=self.done.pk).status_code, 403)
        self.assertEqual(self.client.get(self.url + "action/").status_code, 405)
        csrf = Client(enforce_csrf_checks=True)
        csrf.force_login(self.pm)
        self.assertEqual(
            csrf.post(self.url + "action/", {"action": "watch", "version": 1}).status_code, 403
        )

    def test_comment_ownership_and_revocation_preserves_progress(self):
        self.action(self.member, "start", status=self.active.pk)
        self.action(
            self.member,
            "submit",
            body="Evidence",
            files=[SimpleUploadedFile("proof.txt", b"proof")],
        )
        self.action(self.observer, "comment", body="Original")
        comment = Comment.objects.get()
        self.assertEqual(
            self.action(
                self.member,
                "comment_edit",
                comment_id=comment.pk,
                comment_version=1,
                body="Tampered",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.action(
                self.pm, "comment_edit", comment_id=comment.pk, comment_version=1, body="Tampered"
            ).status_code,
            403,
        )
        self.assertEqual(
            self.action(
                self.observer,
                "comment_edit",
                comment_id=comment.pk,
                comment_version=1,
                body="Edited",
            ).status_code,
            302,
        )
        self.assertEqual(
            self.action(
                self.observer,
                "comment_edit",
                comment_id=comment.pk,
                comment_version=1,
                body="Stale",
            ).status_code,
            409,
        )
        self.assertEqual(
            self.action(
                self.pm, "comment_delete", comment_id=comment.pk, comment_version=2
            ).status_code,
            302,
        )
        membership = Membership.objects.get(project=self.project, user=self.member)
        self.assertEqual(
            self.project_post("team", action="remove", membership_id=membership.pk).status_code, 302
        )
        self.assertTrue(Submission.objects.exists())
        self.assertTrue(Attachment.objects.exists())
        self.assertTrue(get_user_model().objects.filter(pk=self.member.pk).exists())
        self.client.force_login(self.member)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(
            self.client.get(f"/attachments/{Attachment.objects.get().pk}/").status_code, 404
        )
        self.assertNotContains(self.client.get("/notifications/"), "Confidential task")

    @override_settings(TASKA_FILE_LIMIT=4, TASKA_SUBMISSION_LIMIT=6)
    def test_upload_limits_and_failure_leave_no_submission(self):
        self.action(self.member, "start", status=self.active.pk)
        for files in [
            [SimpleUploadedFile("large.bin", b"12345")],
            [SimpleUploadedFile("a", b"1234"), SimpleUploadedFile("b", b"1234")],
        ]:
            self.assertEqual(self.action(self.member, "submit", files=files).status_code, 400)
        self.assertFalse(Submission.objects.exists())
        self.assertEqual(self.action(self.member, "submit", body=" ").status_code, 400)
        with patch("taska.projects.team_views.notify", side_effect=RuntimeError("Failure")):
            with self.assertRaises(RuntimeError), self.assertLogs("django.request", level="ERROR"):
                self.action(self.member, "submit", files=[SimpleUploadedFile("a", b"12")])
        self.assertFalse(Attachment.objects.exists())
        self.assertFalse(any(path.is_file() for path in Path(self.directory.name).rglob("*")))

    def test_status_management_and_atomic_replacement(self):
        self.assertEqual(
            self.project_post(
                "statuses", name="Blocked", category="active", position=3
            ).status_code,
            302,
        )
        blocked = Status.objects.get(name="Blocked")
        self.assertContains(self.client.get("/projects/TEAM/"), "Blocked")
        old_version = self.project.version
        self.assertEqual(
            self.project_post(
                "statuses", status_id=blocked.pk, name="Waiting", category="active", position=4
            ).status_code,
            302,
        )
        self.assertEqual(
            self.client.post(
                "/projects/TEAM/statuses/",
                {"version": old_version, "name": "Race", "category": "queue", "position": 0},
            ).status_code,
            409,
        )
        self.action(self.member, "start", status=blocked.pk)
        self.client.force_login(self.pm)
        self.assertEqual(
            self.project_post(
                "statuses", action="delete", status_id=blocked.pk, replacement=self.done.pk
            ).status_code,
            400,
        )
        self.assertEqual(
            self.project_post(
                "statuses", action="delete", status_id=blocked.pk, replacement=self.active.pk
            ).status_code,
            302,
        )
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.status, self.active)
        self.assertEqual(
            self.project_post(
                "statuses", status_id=self.active.pk, name="Working", category="done", position=1
            ).status_code,
            400,
        )
        self.action(self.member, "submit", body="Review")
        replacement = Status.objects.create(
            project=self.project, name="Acceptance", category="active"
        )
        self.client.force_login(self.pm)
        self.assertEqual(
            self.project_post(
                "statuses", action="delete", status_id=self.review.pk, replacement=replacement.pk
            ).status_code,
            302,
        )
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.status, replacement)
        self.assertTrue(self.issue.status.is_review)
        self.client.force_login(self.member)
        self.assertEqual(self.client.get("/projects/TEAM/statuses/").status_code, 403)

    def make_invitation(self, token="secret", email="new@example.test", **changes):
        return Invitation.objects.create(
            project=self.project,
            email=email,
            role="member",
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            created_by=self.pm,
            expires_at=timezone.now() + timedelta(days=7),
            **changes,
        )

    def test_invitation_new_existing_wrong_account_expiry_and_reuse(self):
        self.make_invitation()
        self.client.logout()
        self.assertNotContains(self.client.get("/invitations/secret/"), "Private team")
        response = self.client.post(
            "/invitations/secret/",
            {
                "username": "new",
                "password1": "strong-password-4523",
                "password2": "strong-password-4523",
            },
        )
        self.assertEqual(response.status_code, 302)
        user = get_user_model().objects.get(username="new")
        self.assertEqual(user.email, "new@example.test")
        self.assertTrue(Membership.objects.filter(user=user, project=self.project).exists())
        self.assertEqual(self.client.post("/invitations/secret/").status_code, 404)
        self.make_invitation(token="existing", email=self.other.email)
        self.assertEqual(self.client.post("/invitations/existing/").status_code, 403)
        self.client.logout()
        self.assertContains(self.client.get("/invitations/existing/"), "Sign in with the account")
        self.client.force_login(self.other)
        self.assertEqual(self.client.post("/invitations/existing/").status_code, 302)
        self.make_invitation(token="revoked", revoked=True)
        self.assertEqual(self.client.get("/invitations/revoked/").status_code, 404)
        invite = self.make_invitation(token="expired")
        Invitation.objects.filter(pk=invite.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertEqual(self.client.get("/invitations/expired/").status_code, 404)

    def test_invitation_management_profile_and_role_escalation(self):
        response = self.project_post("team", email="guest@example.test", role="observer")
        self.assertContains(response, "Copy this invitation link now")
        self.assertEqual(Invitation.objects.count(), 1)
        self.assertFalse(Outbox.objects.exists())
        membership = Membership.objects.get(user=self.member, project=self.project)
        self.assertEqual(
            self.project_post(
                "team", action="role", membership_id=membership.pk, role="manager"
            ).status_code,
            403,
        )
        self.assertEqual(
            self.project_post(
                "team", action="role", membership_id=membership.pk, role="observer"
            ).status_code,
            302,
        )
        self.assertFalse(self.issue.assignees.filter(pk=self.member.pk).exists())
        self.client.force_login(self.member)
        self.assertEqual(
            self.client.post(
                "/profile/",
                {"first_name": "Иван", "last_name": "Петров", "email": self.member.email},
            ).status_code,
            302,
        )
        self.assertContains(self.client.get("/profile/"), "Иван")
        self.assertEqual(self.client.post("/profile/", {"email": self.pm.email}).status_code, 400)

    @override_settings(
        TASKA_EMAIL_ENABLED=True, EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend"
    )
    def test_outbox_delivery_retry_revocation_and_disabled_default(self):
        self.action(self.member, "comment", body="Update")
        self.assertEqual(Outbox.objects.count(), 1)
        with patch(
            "taska.projects.management.commands.send_notifications.send_mail",
            side_effect=OSError("secret credential"),
        ):
            call_command("send_notifications", stdout=io.StringIO(), stderr=io.StringIO())
        item = Outbox.objects.get()
        self.assertEqual(item.attempts, 1)
        self.assertEqual(item.error, "OSError")
        Outbox.objects.update(available_at=timezone.now())
        call_command("send_notifications", stdout=io.StringIO())
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Confidential task", mail.outbox[0].body)
        self.action(self.member, "comment", body="Revoked update")
        Membership.objects.filter(user=self.observer, project=self.project).delete()
        call_command("send_notifications", stdout=io.StringIO())
        self.assertEqual(len(mail.outbox), 1)
        self.assertTrue(Outbox.objects.filter(state="cancelled").exists())
        self.client.force_login(self.pm)
        self.project_post("team", email="new@example.test", role="member")
        call_command("send_notifications", stdout=io.StringIO())
        self.assertEqual(len(mail.outbox), 2)
        self.assertIn("/invitations/", mail.outbox[-1].body)
        self.assertEqual(Outbox.objects.get(invitation__isnull=False).invitation_token, "")
        with (
            override_settings(TASKA_EMAIL_ENABLED=False),
            patch("taska.projects.management.commands.send_notifications.send_mail") as sender,
        ):
            call_command("send_notifications", stdout=io.StringIO())
            sender.assert_not_called()

    def test_task_save_rechecks_status_and_type_after_validation(self):
        target = Status.objects.create(project=self.project, name="Next", category="active")
        for changed in [{"category": "done"}, {"category": "active", "is_review": True}]:
            Status.objects.filter(pk=target.pk).update(category="active", is_review=False)
            form = IssueForm(
                {"title": "Updated", "status": target.pk, "expected_version": self.issue.version},
                project=self.project,
                instance=Issue.objects.get(pk=self.issue.pk),
                user=self.member,
            )
            self.assertTrue(form.is_valid(), form.errors)
            if changed.get("is_review"):
                Status.objects.filter(pk=self.review.pk).update(is_review=False)
            Status.objects.filter(pk=target.pk).update(**changed)
            with self.assertRaises(ValidationError):
                form.save()
            self.issue.refresh_from_db()
            self.assertEqual(self.issue.status, self.queue)
            self.assertEqual(self.issue.title, "Confidential task")
        alternate = IssueType.objects.create(project=self.project, name="Alternate")
        form = IssueForm(
            {
                "title": "Updated",
                "issue_type": alternate.pk,
                "expected_version": self.issue.version,
            },
            project=self.project,
            instance=Issue.objects.get(pk=self.issue.pk),
            user=self.member,
        )
        self.assertTrue(form.is_valid(), form.errors)
        elsewhere = Project.objects.create(key="ELSE", name="Elsewhere")
        IssueType.objects.filter(pk=alternate.pk).update(project=elsewhere)
        with self.assertRaises(ValidationError):
            form.save()
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.issue_type, self.kind)

    @override_settings(
        TASKA_EMAIL_ENABLED=True, EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend"
    )
    def test_deleted_task_does_not_stop_email_batch(self):
        from django.db.models.query import QuerySet

        from .workflow import notify

        self.action(self.member, "comment", body="First update")
        following = Issue.objects.create(
            project=self.project, title="Following task", status=self.queue, issue_type=self.kind
        )
        following.watchers.add(self.observer)
        notify(following, self.pm, "updated")
        update = QuerySet.update
        deleted = False

        def claim_then_delete(queryset, **values):
            nonlocal deleted
            result = update(queryset, **values)
            if queryset.model == Outbox and values.get("state") == "sending" and not deleted:
                deleted = True
                Issue.objects.filter(pk=self.issue.pk).delete()
            return result

        with patch("django.db.models.query.QuerySet.update", new=claim_then_delete):
            call_command("send_notifications", stdout=io.StringIO(), stderr=io.StringIO())
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Following task", mail.outbox[0].body)
        self.assertEqual(Outbox.objects.get().state, "sent")

    def test_deleted_task_cannot_be_saved_from_a_validated_form(self):
        from .forms import ConflictError

        form = IssueForm(
            {"title": "Unsaved work", "expected_version": self.issue.version},
            project=self.project,
            instance=self.issue,
            user=self.member,
        )
        self.assertTrue(form.is_valid(), form.errors)
        Issue.objects.filter(pk=self.issue.pk).delete()
        with self.assertRaises(ConflictError):
            form.save()
        self.assertFalse(Issue.objects.exists())

    def test_project_creation_has_all_basic_types_and_stable_key(self):
        admin = get_user_model().objects.create_superuser("site-admin", password="test-password")
        self.client.force_login(admin)
        data = {
            "key": "NEW",
            "name": "New project",
            "description": "",
            "memberships-TOTAL_FORMS": "0",
            "memberships-INITIAL_FORMS": "0",
            "memberships-MIN_NUM_FORMS": "0",
            "memberships-MAX_NUM_FORMS": "1000",
        }
        response = self.client.post("/admin/projects/project/add/", data)
        self.assertEqual(response.status_code, 302)
        project = Project.objects.get(key="NEW")
        self.assertEqual(
            set(project.issue_types.values_list("name", flat=True)),
            {"Task", "Bug", "Request", "Story", "Epic"},
        )
        self.assertEqual(project.issue_types.get(name="Bug").icon, "bug")
        self.assertEqual(project.statuses.count(), 4)
        self.assertTrue(project.statuses.get(is_review=True).category == "active")
        self.assertEqual(
            self.client.post(
                "/projects/NEW/issues/new/",
                {"title": "First bug", "issue_type": project.issue_types.get(name="Bug").pk},
            ).status_code,
            302,
        )
        data.update(key="CHANGED", name="Renamed project")
        self.assertEqual(
            self.client.post(f"/admin/projects/project/{project.pk}/change/", data).status_code, 302
        )
        project.refresh_from_db()
        self.assertEqual(project.key, "NEW")
        self.assertEqual(project.name, "Renamed project")
        self.assertEqual(project.issues.get().reference, "NEW-1")
        self.assertEqual(self.client.get("/projects/NEW/issues/1/").status_code, 200)

    def test_participant_edit_preserves_subscribed_admin(self):
        admin = get_user_model().objects.create_superuser(
            "watching-admin", password="test-password"
        )
        self.assertEqual(self.action(admin, "watch").status_code, 302)
        self.client.force_login(self.pm)
        response = self.client.get(self.url)
        choices = response.context["participants_form"].fields["watchers"].queryset
        self.assertIn(admin, choices)
        self.assertNotIn(self.outsider, choices)
        self.assertEqual(
            self.action(
                self.pm,
                "participants",
                assignees=[self.member.pk],
                watchers=[self.observer.pk, admin.pk],
            ).status_code,
            302,
        )
        self.assertTrue(self.issue.watchers.filter(pk=admin.pk).exists())

    def test_default_types_backfill_preserves_customization(self):
        from importlib import import_module

        from django.apps import apps
        from django.db import connection

        self.kind.color = "#abcdef"
        self.kind.icon = "bug"
        self.kind.save()
        custom = IssueType.objects.create(
            project=self.project, name="Custom report", color="#123456"
        )
        migrate = import_module(
            "taska.projects.migrations.0007_default_issue_types"
        ).add_missing_types
        editor = connection.schema_editor(atomic=False)
        migrate(apps, editor)
        migrate(apps, editor)
        self.assertEqual(self.project.issue_types.count(), 6)
        self.kind.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual((self.kind.color, self.kind.icon), ("#abcdef", "bug"))
        self.assertEqual(custom.color, "#123456")
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.issue_type_id, self.kind.pk)
