from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Q
from django.shortcuts import get_object_or_404, redirect
from django.utils.translation import gettext as _
from django.utils.translation import gettext_lazy
from django.views.decorators.http import require_POST

from .forms import ConflictError
from .models import Issue, Relation
from .team_views import posted_id, problem, project_for
from .views import visible_projects
from .workflow import lock_issue, lock_project, notify, require_manager

CHOICES = [
    ("related", gettext_lazy("Related task")),
    ("blocks", gettext_lazy("Blocks")),
    ("blocked", gettext_lazy("Blocked by")),
    ("parent", gettext_lazy("Parent of")),
    ("child", gettext_lazy("Child of")),
]


def relation_context(user, issue):
    visible = visible_projects(user)
    links = (
        Relation.objects.filter(
            Q(source=issue) | Q(target=issue),
            source__project__in=visible,
            target__project__in=visible,
        )
        .select_related("source__project", "source__status", "target__project", "target__status")
        .prefetch_related("source__tags", "source__assignees", "target__tags", "target__assignees")
    )
    managed = (
        set(
            visible.filter(memberships__user=user, memberships__role="manager").values_list(
                "pk", flat=True
            )
        )
        if not user.is_superuser
        else set()
    )
    rows = []
    for link in links:
        forward = link.source_id == issue.pk
        other = link.target if forward else link.source
        kind = (
            link.kind
            if forward
            else {"related": "related", "blocks": "blocked", "parent": "child"}[link.kind]
        )
        rows.append(
            {
                "link": link,
                "other": other,
                "kind": kind,
                "label": dict(CHOICES)[kind],
                "editable": user.is_superuser
                or (issue.project_id in managed and other.project_id in managed),
            }
        )
    children = Relation.objects.filter(source=issue, kind="parent")
    # Never disclose hidden children's counts or aggregate completion.
    progress = None
    if children.exists() and not children.exclude(target__project__in=visible).exists():
        total = children.count()
        done = children.filter(target__status__category="done").count()
        progress = {"done": done, "total": total, "percent": round(done * 100 / total)}
    if issue.issue_type.name.lower() in {"bug", "request"}:
        progress = {
            "done": int(issue.status.category == "done"),
            "total": 1,
            "percent": 100 if issue.status.category == "done" else 0,
        }
    return {
        "relations": rows,
        "relation_choices": CHOICES,
        "child_progress": progress,
        "relation_query": "",
    }


@require_POST
def relation_action(request, key, number):
    project = project_for(request, key)
    issue = get_object_or_404(project.issues, number=number)
    try:
        with transaction.atomic():
            lock_issue(issue, posted_id(request, "version"))
            require_manager(request.user, project)
            if request.POST.get("relation"):
                link = get_object_or_404(
                    Relation.objects.filter(Q(source=issue) | Q(target=issue)),
                    pk=posted_id(request, "relation"),
                )
                if link.version != posted_id(request, "relation_version"):
                    raise ConflictError
                other_id = link.target_id if link.source_id == issue.pk else link.source_id
            else:
                link = Relation()
                other_id = posted_id(request, "target")
            other = get_object_or_404(
                Issue.objects.select_related("project"),
                pk=other_id,
                project__in=visible_projects(request.user),
            )
            if other.project_id != project.pk:
                lock_project(other.project)
            require_manager(request.user, other.project)
            if request.POST.get("action") == "delete":
                if not link.pk:
                    raise ValidationError(_("Choose a valid item."))
                link.delete()
            else:
                kind = request.POST.get("kind")
                if kind not in dict(CHOICES):
                    raise ValidationError(_("Choose a valid item."))
                reverse = kind in {"blocked", "child"}
                link.source, link.target = (other, issue) if reverse else (issue, other)
                link.kind = {"blocked": "blocks", "child": "parent"}.get(kind, kind)
                if link.pk:
                    link.version += 1
                link.save()
            Issue.objects.filter(pk=other.pk).update(version=F("version") + 1)
            notify(issue, request.user, "updated")
            notify(other, request.user, "updated")
    except ConflictError:
        return problem(request, _("This relation changed. Reload the task and try again."), 409)
    except ValidationError as error:
        return problem(request, " ".join(error.messages))
    return redirect("issue-detail", key=key, number=number)
