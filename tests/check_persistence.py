"""Isolated file-backed upgrade, concurrency and persistence check.

Run: PYTHONPATH=src python tests/check_persistence.py
"""

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def main():
    workspace = tempfile.TemporaryDirectory(prefix="taska-audit12-")
    folder = Path(workspace.name)
    os.environ["DJANGO_SETTINGS_MODULE"] = "taska.settings"
    os.environ["TASKA_DATABASE_PATH"] = str(folder / "audit.sqlite3")
    os.environ["TASKA_MEDIA_ROOT"] = str(folder / "uploads")
    os.environ["TASKA_DEBUG"] = "true"
    import django

    django.setup()
    from django.contrib.auth import get_user_model
    from django.core.files.base import ContentFile
    from django.core.management import call_command
    from django.db import close_old_connections, connection

    from taska.projects.models import (
        Attachment,
        Comment,
        Issue,
        IssueType,
        Project,
        Status,
        Submission,
    )

    call_command("migrate", verbosity=0)
    call_command("migrate", "projects", "0006", verbosity=0)
    from django.db.migrations.executor import MigrationExecutor

    old_apps = (
        MigrationExecutor(connection)
        .loader.project_state([("projects", "0006_review_status")])
        .apps
    )
    OldProject = old_apps.get_model("projects", "Project")
    OldIssue = old_apps.get_model("projects", "Issue")
    project = OldProject.objects.create(key="AUDIT", name="Audit project", next_issue_number=43)
    queue = Status.objects.create(project_id=project.pk, name="To do", category="queue")
    kind = IssueType.objects.create(project_id=project.pk, name="Task", color="#123456", icon="bug")
    IssueType.objects.create(project_id=project.pk, name="Custom", color="#abcdef")
    seed = OldIssue.objects.create(
        project_id=project.pk,
        number=42,
        title="Preserved issue",
        status_id=queue.pk,
        issue_type_id=kind.pk,
    )
    call_command("migrate", verbosity=0)
    project = Project.objects.get(pk=project.pk)
    seed = Issue.objects.get(pk=seed.pk)
    assert seed.position == 42
    kind.refresh_from_db()
    assert project.issue_types.count() == 6
    assert kind.color == "#123456" and kind.icon == "bug"
    assert seed.reference == "AUDIT-42"

    project_id, status_id, type_id = project.pk, queue.pk, kind.pk

    def create_batch(worker):
        close_old_connections()
        numbers = []
        for index in range(5):
            issue = Issue.objects.create(
                project_id=project_id,
                status_id=status_id,
                issue_type_id=type_id,
                title=f"Worker {worker}, task {index}",
            )
            numbers.append(issue.number)
        connection.close()
        return numbers

    with ThreadPoolExecutor(max_workers=2) as pool:
        batches = list(pool.map(create_batch, [1, 2]))
    assert sorted(number for batch in batches for number in batch) == list(range(43, 53))
    Issue.objects.get(project_id=project.pk, number=52).delete()
    issue = Issue.objects.create(
        project_id=project.pk, title="After deletion", status=queue, issue_type=kind
    )
    assert issue.number == 53
    user = get_user_model().objects.create_user("author", email="author@example.test")
    issue.assignees.add(user)
    Comment.objects.create(issue=issue, author=user, body="Retained comment")
    submission = Submission.objects.create(
        issue=issue, author=user, body="Retained report", issue_version=issue.version
    )
    attachment = Attachment(submission=submission, name="report.txt", size=8)
    attachment.file.save("stored-report", ContentFile(b"evidence"))
    filename = Path(attachment.file.path)
    issue.assignees.clear()
    connection.close()
    assert Comment.objects.get(issue=issue).body == "Retained comment"
    assert Submission.objects.get(issue=issue).body == "Retained report"
    assert Attachment.objects.get(submission=submission).file.read() == b"evidence"
    assert get_user_model().objects.filter(pk=user.pk).exists()
    Issue.objects.get(pk=issue.pk).delete()
    assert not filename.exists()
    assert (
        Issue.objects.create(
            project_id=project.pk, title="Next", status=queue, issue_type=kind
        ).number
        == 54
    )
    from django.core.exceptions import ValidationError

    from taska.projects.models import Relation

    endpoints = (seed.pk, Issue.objects.get(project=project, number=54).pk)

    def add_opposing_relation(reverse):
        close_old_connections()
        source, target = endpoints[::-1] if reverse else endpoints
        try:
            Relation.objects.create(source_id=source, target_id=target, kind="parent")
            return "created"
        except ValidationError:
            return "rejected"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(add_opposing_relation, [False, True])) == ["created", "rejected"]
    connection.close()
    assert Relation.objects.count() == 1
    print(
        "PASS: concurrent opposing hierarchy links cannot form a cycle; relation persists after reconnect."
    )
    print(
        "PASS: 0006→current upgrade preserves configured types, IDs and card order; parallel creation allocates 43–52 once; deleted IDs are not reused; reports/files survive reconnect and unassignment; confirmed task deletion cleans stored files."
    )

    connection.close()
    workspace.cleanup()


if __name__ == "__main__":
    main()
