import io

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from PIL import Image

from .models import Issue, IssueType, Membership, Profile, Project, Status, Tag


class ProfileAndEditorTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.pm = User.objects.create_user("pm")
        self.member = User.objects.create_user("member")
        self.outsider = User.objects.create_user("outsider")
        self.project = Project.objects.create(key="UI", name="UI")
        Membership.objects.create(project=self.project, user=self.pm, role="manager")
        Membership.objects.create(project=self.project, user=self.member, role="member")
        self.first = Status.objects.create(
            project=self.project, name="First", category="queue", position=10
        )
        self.second = Status.objects.create(
            project=self.project, name="Second", category="active", position=20
        )
        self.kind = IssueType.objects.create(project=self.project, name="Task")
        self.issue = Issue.objects.create(
            project=self.project, title="Original", status=self.first, issue_type=self.kind
        )
        self.client.force_login(self.pm)

    def test_avatar_normalization_profile_access_and_removal(self):
        image = io.BytesIO()
        Image.new("RGB", (600, 300), "blue").save(image, format="PNG")
        upload = SimpleUploadedFile("avatar.png", image.getvalue(), content_type="image/png")
        response = self.client.post(
            "/profile/", {"first_name": "PM", "bio": "Hello", "avatar": upload}
        )
        self.assertEqual(response.status_code, 302)
        record = Profile.objects.get(user=self.pm)
        with Image.open(io.BytesIO(record.avatar)) as normalized:
            self.assertEqual(normalized.size, (256, 128))
            self.assertEqual(normalized.format, "PNG")
        self.client.force_login(self.member)
        self.assertContains(self.client.get(f"/people/{self.pm.pk}/"), "Hello")
        self.assertEqual(
            self.client.get(f"/people/{self.pm.pk}/avatar/")["Content-Type"], "image/png"
        )
        self.assertEqual(
            self.client.post(f"/people/{self.pm.pk}/", {"bio": "overwrite"}).status_code, 403
        )
        self.client.force_login(self.outsider)
        for suffix in ("", "avatar/"):
            self.assertEqual(self.client.get(f"/people/{self.pm.pk}/" + suffix).status_code, 404)
        self.client.logout()
        self.assertEqual(self.client.get(f"/people/{self.pm.pk}/avatar/").status_code, 302)
        self.client.force_login(self.pm)
        bad = SimpleUploadedFile("bad.png", b'<svg onload="alert(1)"/>', content_type="image/png")
        self.assertEqual(self.client.post("/profile/", {"avatar": bad}).status_code, 400)
        record.refresh_from_db()
        self.assertTrue(record.avatar)
        self.assertEqual(self.client.post("/profile/", {"remove_avatar": "on"}).status_code, 302)
        record.refresh_from_db()
        self.assertFalse(record.avatar)

    def test_tags_survive_tasks_and_watching_is_one_control(self):
        tag = Tag.objects.create(project=self.project, name="backend")
        self.issue.tags.add(tag)
        url = f"/projects/UI/issues/{self.issue.number}/"
        self.assertContains(self.client.get(url), 'value="watch"', count=1)
        self.assertNotContains(self.client.get(url), 'value="unwatch"')
        self.client.post(url + "action/", {"action": "watch", "version": self.issue.version})
        page = self.client.get(url)
        self.assertContains(page, 'value="unwatch"', count=1)
        self.assertNotContains(page, 'value="watch"')
        self.assertContains(page, f'href="/people/{self.pm.pk}/"')
        self.issue.delete()
        self.assertContains(self.client.get("/projects/UI/issues/new/"), 'data-tag="backend"')
        self.assertContains(
            self.client.get("/notifications/"), 'aria-current="page" title="Notifications"'
        )

    def test_columns_use_arrows_and_reject_stale_order(self):
        url = "/projects/UI/statuses/"
        response = self.client.get(url)
        self.assertNotContains(response, 'name="position"')
        self.assertContains(response, "Reports submitted by assignees")
        data = {"version": self.project.version, "status_id": self.second.pk, "action": "left"}
        self.assertEqual(self.client.post(url, data).status_code, 302)
        self.assertEqual(
            list(self.project.statuses.values_list("pk", flat=True)),
            [self.second.pk, self.first.pk],
        )
        self.assertEqual(self.client.post(url, data).status_code, 409)
        self.project.refresh_from_db()
        self.client.post(
            url, {"version": self.project.version, "name": "Last", "category": "queue"}
        )
        self.assertEqual(
            list(self.project.statuses.values_list("name", flat=True)), ["Second", "First", "Last"]
        )
