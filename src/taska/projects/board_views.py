"""Board writes use the same permissions and project lock as task forms."""

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_POST

from .forms import ConflictError
from .models import Issue
from .team_views import posted_id, problem, project_for
from .workflow import (
    can_edit_issue,
    is_manager,
    lock_issue,
    lock_project,
    notify,
    require_manager,
    set_issue_status,
    validate_edit_status,
)


@require_POST
def board_action(request, key):
    project = project_for(request, key)
    try:
        with transaction.atomic():
            board_version = posted_id(request, "board_version")
            if request.POST.get("action") == "rename":
                lock_project(project, board_version)
                require_manager(request.user, project)
                status = get_object_or_404(project.statuses, pk=posted_id(request, "status"))
                status.name = request.POST.get("name", "").strip()
                status.full_clean()
                status.save(update_fields=["name"])
            else:
                issue = get_object_or_404(project.issues, pk=posted_id(request, "issue"))
                lock_issue(issue, posted_id(request, "version"), board_version)
                target = get_object_or_404(project.statuses, pk=posted_id(request, "status"))
                manager = is_manager(request.user, project)
                if not manager and not can_edit_issue(request.user, issue):
                    raise PermissionDenied
                if issue.status_id != target.pk:
                    if manager:
                        # A PM's board move is itself the decision; no second confirmation.
                        if issue.status.is_review:
                            issue.submissions.filter(decision="").update(
                                decision="approved" if target.category == "done" else "returned",
                                reviewer=request.user,
                                decided_at=timezone.now(),
                            )
                    elif target.is_review:
                        raise ValidationError(_("Open the task and submit progress for review."))
                    else:
                        validate_edit_status(request.user, issue, target)
                    set_issue_status(issue, target)
                    notify(
                        issue, request.user, "status", issue.assignees.values_list("pk", flat=True)
                    )
                # ponytail: serialize a project's board; use column locks if write volume grows.
                ordered = list(project.issues.filter(status=target).order_by("position", "number"))
                old_index = next(i for i, item in enumerate(ordered) if item.pk == issue.pk)
                ordered = [item for item in ordered if item.pk != issue.pk]
                direction = request.POST.get("direction")
                if direction in ("up", "down"):
                    index = max(0, min(len(ordered), old_index + (-1 if direction == "up" else 1)))
                elif request.POST.get("before"):
                    before = posted_id(request, "before")
                    index = next((i for i, item in enumerate(ordered) if item.pk == before), None)
                    if index is None:
                        raise ValidationError(_("Choose a valid item."))
                else:
                    index = len(ordered)
                ordered.insert(index, issue)
                for index, item in enumerate(ordered):
                    item.position = index
                Issue.objects.bulk_update(ordered, ["position"])
    except (ValidationError, ConflictError) as error:
        conflict = isinstance(error, ConflictError)
        message = (
            _("The board changed. Reload the page and try again.")
            if conflict
            else " ".join(error.messages)
        )
        if "application/json" in request.headers.get("Accept", ""):
            return JsonResponse({"error": message}, status=409 if conflict else 400)
        return problem(request, message, status=409 if conflict else 400)
    if "application/json" in request.headers.get("Accept", ""):
        return JsonResponse({"ok": True})
    return redirect("project-board", key=key)
