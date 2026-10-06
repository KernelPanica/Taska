from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import Issue, IssueType, Membership, Project, Relation, Status


class RelationTests(TestCase):
    def setUp(self):
        self.pm = get_user_model().objects.create_user("pm")
        self.member = get_user_model().objects.create_user("member")
        self.project = Project.objects.create(key="TREE", name="Tree")
        Membership.objects.create(project=self.project, user=self.pm, role="manager")
        Membership.objects.create(project=self.project, user=self.member, role="member")
        self.queue = Status.objects.create(project=self.project, name="Queue", category="queue")
        self.done = Status.objects.create(project=self.project, name="Done", category="done")
        kind = IssueType.objects.create(project=self.project, name="Task")
        self.tasks = [
            Issue.objects.create(
                project=self.project, status=self.queue, issue_type=kind, title=f"Level {i}"
            )
            for i in range(4)
        ]
        self.client.force_login(self.pm)

    def post(self, issue, other=None, **extra):
        issue.refresh_from_db()
        return self.client.post(
            f"/projects/TREE/issues/{issue.number}/relations/",
            {
                "version": issue.version,
                "target": other.pk if other else "",
                "kind": "parent",
                **extra,
            },
        )

    def test_four_levels_cycles_changes_and_removal(self):
        for parent, child in zip(self.tasks, self.tasks[1:]):
            self.assertEqual(self.post(parent, child).status_code, 302)
        self.assertEqual(self.post(self.tasks[-1], self.tasks[0]).status_code, 400)
        self.assertEqual(self.post(self.tasks[0], self.tasks[0]).status_code, 400)
        link = Relation.objects.get(source=self.tasks[0])
        old_pk = link.pk
        self.assertEqual(
            self.post(
                self.tasks[0], relation=link.pk, relation_version=link.version, kind="blocks"
            ).status_code,
            302,
        )
        link.refresh_from_db()
        self.assertEqual(link.pk, old_pk)
        self.assertEqual(link.kind, "blocks")
        self.assertContains(self.client.get("/projects/TREE/issues/1/"), "Blocks")
        self.assertContains(self.client.get("/projects/TREE/issues/2/"), "Blocked by")
        self.assertEqual(
            self.post(
                self.tasks[0], relation=link.pk, relation_version=1, kind="related"
            ).status_code,
            409,
        )
        self.assertEqual(
            self.post(
                self.tasks[0], relation=link.pk, relation_version=link.version, action="delete"
            ).status_code,
            302,
        )
        self.assertEqual(Issue.objects.count(), 4)

    def test_reverse_duplicates_parent_uniqueness_and_progress(self):
        self.assertEqual(self.post(self.tasks[0], self.tasks[1]).status_code, 302)
        self.assertEqual(self.post(self.tasks[1], self.tasks[0], kind="related").status_code, 400)
        self.assertEqual(self.post(self.tasks[2], self.tasks[1]).status_code, 400)
        self.assertEqual(self.post(self.tasks[0], self.tasks[2]).status_code, 302)
        Issue.objects.filter(pk=self.tasks[1].pk).update(status=self.done)
        page = self.client.get("/projects/TREE/issues/1/")
        self.assertEqual(page.context["child_progress"], {"done": 1, "total": 2, "percent": 50})
        with self.assertRaises(ValidationError):
            Relation.objects.create(source=self.tasks[2], target=self.tasks[0], kind="parent")

    def test_cross_project_privacy_and_permissions(self):
        private = Project.objects.create(key="PRIVATE", name="Hidden project")
        Membership.objects.create(project=private, user=self.pm, role="manager")
        status = Status.objects.create(project=private, name="Secret status", category="queue")
        kind = IssueType.objects.create(project=private, name="Task")
        target = Issue.objects.create(
            project=private, title="Secret child", issue_type=kind, status=status
        )
        self.assertEqual(self.post(self.tasks[0], target).status_code, 302)
        self.client.force_login(self.member)
        page = self.client.get("/projects/TREE/issues/1/")
        self.assertNotContains(page, "Secret child")
        self.assertIsNone(page.context["child_progress"])
        self.assertEqual(self.post(self.tasks[1], self.tasks[2]).status_code, 403)
        self.client.logout()
        self.assertEqual(self.post(self.tasks[1], self.tasks[2]).status_code, 302)
        self.client.force_login(self.pm)
        Membership.objects.filter(project=private, user=self.pm).update(role="observer")
        self.assertEqual(self.post(self.tasks[1], target, kind="blocks").status_code, 403)
