import json
import os
import secrets
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.translation import gettext_noop

from taska.projects.models import (
    DEFAULT_ISSUE_TYPES,
    Board,
    Issue,
    IssueType,
    Membership,
    Project,
    Status,
)


class Command(BaseCommand):
    help = "Create local demo accounts and an empty TASKA project; never reset existing data."

    def add_arguments(self, parser):
        parser.add_argument(
            "--with-issues",
            action="store_true",
            help="Add a separate SAMPLE project with three issues.",
        )
        parser.add_argument(
            "--credentials-file", default=str(settings.BASE_DIR / ".demo-credentials.json")
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.DEBUG or os.environ.get("TASKA_DEMO_MODE") != "true":
            raise CommandError(
                "Demo seeding requires TASKA_DEBUG=true and TASKA_DEMO_MODE=true. Use a local demo database."
            )
        path = Path(options["credentials_file"])
        credentials = json.loads(path.read_text()) if path.exists() else {}
        users = {}
        for role in ("admin", "manager", "member", "observer"):
            username = f"demo-{role}"
            user = get_user_model().objects.filter(username=username).first()
            if user is None:
                password = secrets.token_urlsafe(18)
                user = get_user_model().objects.create_user(
                    username,
                    email=f"{username}@example.test",
                    password=password,
                    is_staff=role == "admin",
                    is_superuser=role == "admin",
                )
                credentials[username] = password
            elif username not in credentials:
                raise CommandError(
                    f"{username} already exists without its credentials file. No account was changed."
                )
            users[role] = user
        projects = [("TASKA", "Taska", "Task tracking project.")]
        if options["with_issues"]:
            projects.append(
                (
                    "SAMPLE",
                    "Sample project",
                    "Sample issues for exploring the workspace.",
                )
            )
        for key, name, description in projects:
            project, _ = Project.objects.get_or_create(
                key=key, defaults={"name": name, "description": description}
            )
            for role in ("manager", "member", "observer"):
                Membership.objects.get_or_create(
                    project=project, user=users[role], defaults={"role": role}
                )
            Board.objects.get_or_create(project=project, name=gettext_noop("Team board"))
            statuses = []
            for position, (name, category) in enumerate(
                (
                    (gettext_noop("To do"), "queue"),
                    (gettext_noop("In progress"), "active"),
                    (gettext_noop("Done"), "done"),
                )
            ):
                status, _ = Status.objects.get_or_create(
                    project=project,
                    name=name,
                    defaults={
                        "category": category,
                        "position": 3 if category == "done" else position,
                    },
                )
                statuses.append(status)
            Status.objects.get_or_create(
                project=project,
                is_review=True,
                defaults={"name": gettext_noop("In review"), "category": "active", "position": 2},
            )
            for name in DEFAULT_ISSUE_TYPES:
                IssueType.objects.get_or_create(
                    project=project,
                    name=name,
                    defaults={"icon": "bug" if name == gettext_noop("Bug") else "issue"},
                )
            if key == "SAMPLE":
                project.refresh_from_db(fields=["next_issue_number"])
                for number, title in enumerate(
                    (
                        "Review the project brief",
                        "Discuss the first iteration",
                        "Set up the workspace",
                    ),
                    start=1,
                ):
                    if number < project.next_issue_number:
                        continue
                    Issue.objects.get_or_create(
                        project=project,
                        number=number,
                        defaults={
                            "title": title,
                            "description": "A sample issue. Open it to edit the description, status and other fields.",
                            "status": statuses[number - 1],
                            "issue_type": project.issue_types.get(name=gettext_noop("Task")),
                        },
                    )
        # Keep generated passwords out of command output and source control.
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as file:
            os.fchmod(file.fileno(), 0o600)
            json.dump(credentials, file, indent=2)
            file.write("\n")
        self.stdout.write(self.style.SUCCESS(f"Demo ready. Local credentials: {path}"))
