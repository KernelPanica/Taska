"""Shared permissions and atomic workflow writes for forms and task actions."""

from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import F
from django.utils import timezone
from django.utils.translation import gettext as _
from django.utils.translation import gettext_lazy

from .forms import ConflictError
from .models import Issue, Membership, Notification, Outbox, Project, next_issue_position


def is_manager(user, project):
    return (
        user.is_superuser
        or Membership.objects.filter(project=project, user=user, role="manager").exists()
    )


def is_member(user, project):
    return Membership.objects.filter(project=project, user=user, role="member").exists()


def can_work(user, issue):
    return is_manager(user, issue.project) or (
        is_member(user, issue.project) and issue.assignees.filter(pk=user.pk).exists()
    )


def can_edit_issue(user, issue):
    return can_work(user, issue) and not issue.status.is_review and issue.status.category != "done"


def require_manager(user, project):
    if not is_manager(user, project):
        raise PermissionDenied


def lock_project(project, version=None):
    query = Project.objects.filter(pk=project.pk)
    if version is not None:
        query = query.filter(version=version)
    if not query.update(version=F("version") + 1):
        raise ConflictError
    project.refresh_from_db()


def lock_issue(issue, version, project_version=None):
    # Call inside atomic(). Lock the shared project before rechecking roles and task state.
    lock_project(issue.project, project_version)
    if not Issue.objects.filter(pk=issue.pk, version=version).update(version=F("version") + 1):
        raise ConflictError
    issue.refresh_from_db()


def validate_edit_status(user, issue, target, creating=False):
    if creating:
        if target.category != "queue":
            raise ValidationError(_("New tasks must start in a queue status."))
        return
    if target.pk == issue.status_id:
        return
    if target.is_review or target.category == "done":
        raise ValidationError(_("Use Submit for review or the review decision controls."))
    if issue.status.is_review or issue.status.category == "done":
        raise ValidationError(_("Use the review decision or reopen controls."))
    if not is_manager(user, issue.project) and target.category != "active":
        raise PermissionDenied


def notify(issue, actor, kind, recipients=None):
    from django.conf import settings

    ids = set(issue.watchers.values_list("pk", flat=True))
    if recipients is not None:
        ids.update(recipients)
    eligible = Membership.objects.filter(
        project=issue.project, user_id__in=ids, user__is_active=True
    ).values_list("user_id", flat=True)
    from django.contrib.auth import get_user_model

    admins = (
        get_user_model()
        .objects.filter(pk__in=ids, is_superuser=True, is_active=True)
        .values_list("pk", flat=True)
    )
    for user_id in set(eligible) | set(admins):
        event = Notification.objects.create(user_id=user_id, issue=issue, actor=actor, kind=kind)
        if settings.TASKA_EMAIL_ENABLED:
            Outbox.objects.create(notification=event, available_at=timezone.now())


def managers(project):
    from django.contrib.auth import get_user_model

    return set(project.memberships.filter(role="manager").values_list("user_id", flat=True)) | set(
        get_user_model()
        .objects.filter(is_superuser=True, is_active=True)
        .values_list("pk", flat=True)
    )


EVENT_LABELS = {
    "updated": gettext_lazy("Task updated"),
    "comment": gettext_lazy("New comment"),
    "comment_edited": gettext_lazy("Comment edited"),
    "comment_deleted": gettext_lazy("Comment deleted"),
    "submitted": gettext_lazy("Progress submitted for review"),
    "approved": gettext_lazy("Review approved"),
    "returned": gettext_lazy("Changes requested"),
    "assignment_requested": gettext_lazy("Assignment requested"),
    "assignment_approved": gettext_lazy("Assignment approved"),
    "assignment_rejected": gettext_lazy("Assignment rejected"),
    "participants": gettext_lazy("Task participants updated"),
    "status": gettext_lazy("Status changed"),
}


def set_issue_status(issue, target):
    """Append to the destination column; callers already hold the project write lock."""
    if issue.status_id != target.pk:
        issue.position = next_issue_position(issue.project_id, target.pk)
        Issue.objects.filter(pk=issue.pk).update(status=target, position=issue.position)
        issue.status = target


def transition_issue(issue, user, target, action):
    """Shared by task controls and the board; called after locking/version validation."""
    if action == "start":
        if not can_edit_issue(user, issue) or target.category != "active" or target.is_review:
            raise PermissionDenied
    elif action == "reopen":
        require_manager(user, issue.project)
        if issue.status.category != "done" or target.category != "active" or target.is_review:
            raise ValidationError(_("Choose an active working status."))
    else:
        require_manager(user, issue.project)
        if not issue.status.is_review:
            raise ValidationError(_("Only submitted work can be reviewed."))
        submission = issue.submissions.filter(decision="").first()
        if not submission:
            raise ValidationError(_("There is no pending submission."))
        if action == "approve" and target.category != "done":
            raise ValidationError(_("Choose a completed status."))
        if action == "return" and (target.category != "active" or target.is_review):
            raise ValidationError(_("Choose an active working status."))
        submission.decision = "approved" if action == "approve" else "returned"
        submission.reviewer = user
        submission.decided_at = timezone.now()
        submission.save(update_fields=["decision", "reviewer", "decided_at"])
    set_issue_status(issue, target)
    kind = {"approve": "approved", "return": "returned"}.get(action, "status")
    notify(issue, user, kind, issue.assignees.values_list("pk", flat=True))
