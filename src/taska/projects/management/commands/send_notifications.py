from datetime import timedelta

from django.conf import settings
from django.core.mail import send_mail
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from django.utils.translation import gettext as _

from taska.projects.models import Outbox
from taska.projects.views import visible_projects
from taska.projects.workflow import EVENT_LABELS, is_manager, lock_project


class Command(BaseCommand):
    help = "Deliver queued email. Safe to schedule every minute; no work when email is disabled."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=50)
        parser.add_argument("--retry-failed", action="store_true")

    def handle(self, *args, **options):
        if not settings.TASKA_EMAIL_ENABLED:
            self.stdout.write("Email is disabled.")
            return
        if options["retry_failed"]:
            Outbox.objects.filter(state="failed").update(
                state="pending", available_at=timezone.now(), attempts=0
            )
        # Recover a worker killed after claiming a message. SMTP delivery is at-least-once.
        Outbox.objects.filter(state="sending", available_at__lt=timezone.now()).update(
            state="pending"
        )
        ids = (
            Outbox.objects.filter(state="pending", available_at__lte=timezone.now())
            .order_by("pk")
            .values_list("pk", flat=True)[: options["limit"]]
        )
        for pk in list(ids):
            if not Outbox.objects.filter(pk=pk, state="pending").update(
                state="sending", available_at=timezone.now() + timedelta(minutes=5)
            ):
                continue
            item = (
                Outbox.objects.select_related(
                    "notification__issue__project",
                    "notification__user",
                    "invitation__project",
                    "invitation__created_by",
                )
                .filter(pk=pk)
                .first()
            )
            if item is None:
                continue
            try:
                with transaction.atomic():
                    if item.notification_id:
                        event = item.notification
                        lock_project(event.issue.project)
                        event.user.refresh_from_db()
                        event.issue.refresh_from_db()
                        if (
                            not event.user.is_active
                            or not visible_projects(event.user)
                            .filter(pk=event.issue.project_id)
                            .exists()
                            or not event.user.email
                        ):
                            self.finish(item, "cancelled")
                            continue
                        address = event.user.email
                        subject = f"Taska · {event.issue.reference} · {EVENT_LABELS.get(event.kind, event.kind)}"
                        body = (
                            event.issue.title
                            + "\n"
                            + settings.TASKA_PUBLIC_URL
                            + f"/projects/{event.issue.project.key}/issues/{event.issue.number}/"
                        )
                    else:
                        invite = item.invitation
                        lock_project(invite.project)
                        invite.refresh_from_db()
                        if (
                            invite.revoked
                            or invite.consumed_at
                            or invite.expires_at <= timezone.now()
                            or not invite.created_by.is_active
                            or not is_manager(invite.created_by, invite.project)
                        ):
                            self.finish(item, "cancelled")
                            continue
                        address = invite.email
                        subject = _("Invitation to Taska")
                        body = settings.TASKA_PUBLIC_URL + f"/invitations/{item.invitation_token}/"
                    # ponytail: serialized send holds the project lock to prevent access revocation
                    # racing delivery; use a dedicated delivery service if email throughput warrants it.
                    send_mail(
                        subject, body, settings.DEFAULT_FROM_EMAIL, [address], fail_silently=False
                    )
                    self.finish(item, "sent")
            except Exception as error:
                item.attempts += 1
                item.state = "failed" if item.attempts >= 5 else "pending"
                # SMTP exceptions can include credentials or message contents; retain only the type.
                item.error = type(error).__name__
                item.available_at = timezone.now() + timedelta(minutes=2**item.attempts)
                Outbox.objects.filter(pk=item.pk).update(
                    attempts=item.attempts,
                    state=item.state,
                    error=item.error,
                    available_at=item.available_at,
                )
                self.stderr.write(f"Outbox {pk}: {item.error}")

    def finish(self, item, state):
        item.state = state
        item.error = ""
        item.invitation_token = ""
        item.save(update_fields=["state", "error", "invitation_token"])
