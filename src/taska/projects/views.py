from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Prefetch
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_GET, require_http_methods

from .forms import ConflictError, IssueForm, IssueTypeForm
from .markdown import render_markdown
from .models import Board, Issue, IssueType, Project
from .team_forms import CommentForm, ParticipantsForm, ProgressForm
from .workflow import can_edit_issue, is_manager, lock_project, require_manager


def visible_projects(user):
    if not user.is_authenticated:
        return Project.objects.none()
    if user.is_superuser:
        return Project.objects.all()
    return Project.objects.filter(memberships__user=user)


def navigation(request):
    return {"navigation_projects": visible_projects(request.user)}


@login_required
@require_GET
def project_list(request):
    projects = visible_projects(request.user).annotate(issue_count=Count("issues", distinct=True))
    return render(request, "projects/list.html", {"projects": projects})


@login_required
@require_GET
def project_board(request, key):
    project = get_object_or_404(visible_projects(request.user), key=key)
    board = project.boards.first()
    manager = is_manager(request.user, project)
    member = project.memberships.filter(user=request.user, role="member").exists()
    issues = (
        project.issues.select_related("issue_type", "project")
        .prefetch_related("tags", "assignees")
        .order_by("position", "number")
    )
    for field, related in (("tag", project.tags), ("assignee", project.memberships)):
        value = request.GET.get(field)
        if value:
            if field == "tag":
                item = get_object_or_404(
                    related,
                    pk=int(value)
                    if value.isascii() and value.isdecimal() and len(value) < 19
                    else 0,
                )
                issues = issues.filter(tags=item)
            else:
                item = get_object_or_404(
                    related,
                    user_id=int(value)
                    if value.isascii() and value.isdecimal() and len(value) < 19
                    else 0,
                )
                issues = issues.filter(assignees=item.user_id)
    statuses = list(project.statuses.prefetch_related(Prefetch("issues", queryset=issues)))
    today = timezone.localdate()
    for status in statuses:
        for issue in status.issues.all():
            assigned = any(person.pk == request.user.pk for person in issue.assignees.all())
            issue.can_move = manager or (
                member and assigned and not status.is_review and status.category != "done"
            )
            issue.overdue = issue.due_date and issue.due_date < today and status.category != "done"
            issue.move_targets = [
                target
                for target in statuses
                if manager
                or target.pk == status.pk
                or (
                    not target.is_review
                    and (
                        (status.is_review and manager and target.category in ("active", "done"))
                        or (status.category == "done" and manager and target.category == "active")
                        or (
                            not status.is_review
                            and status.category != "done"
                            and (
                                target.category == "active"
                                or (manager and target.category == "queue")
                            )
                        )
                    )
                )
            ]
    return render(
        request,
        "projects/board.html",
        {
            "project": project,
            "board": board,
            "statuses": statuses,
            "can_edit": manager,
            "filtered": bool(request.GET.get("tag") or request.GET.get("assignee")),
        },
    )


@login_required
@require_http_methods(["GET", "POST"])
def issue_detail(request, key, number, editor_form=None, preview=None, response_status=200):
    if request.method == "POST" and editor_form is None:
        return issue_edit(request, key, number)
    project = get_object_or_404(visible_projects(request.user), key=key)
    issue = get_object_or_404(
        Issue.objects.select_related("status", "issue_type"), project=project, number=number
    )
    from .relation_views import relation_context

    relation_data = relation_context(request.user, issue)
    search = request.GET.get("link_search", "").strip()[:200]
    relation_data["relation_query"] = search
    if search and is_manager(request.user, project):
        from django.db.models import Q

        candidates = (
            Issue.objects.filter(project__in=visible_projects(request.user))
            .exclude(pk=issue.pk)
            .select_related("project")
        )
        if not request.user.is_superuser:
            candidates = candidates.filter(
                project__memberships__user=request.user, project__memberships__role="manager"
            )
        key_part, _, number_part = search.rpartition("-")
        query = Q(title__icontains=search)
        if number_part.isascii() and number_part.isdecimal() and len(number_part) < 10:
            query |= Q(project__key__iexact=key_part, number=int(number_part))
        relation_data["relation_candidates"] = candidates.filter(query)[:30]
    return render(
        request,
        "projects/issue.html",
        {
            "project": project,
            "issue": issue,
            "can_edit": can_edit_issue(request.user, issue),
            "manager": is_manager(request.user, project),
            "can_work": can_edit_issue(request.user, issue),
            "participants_form": ParticipantsForm(issue=issue),
            "progress_form": ProgressForm(initial={"version": issue.version}),
            "comment_form": CommentForm(),
            "comments": [
                {
                    "item": c,
                    "html": render_markdown(c.body),
                    "can_delete": c.author_id == request.user.pk
                    or is_manager(request.user, project),
                }
                for c in issue.comments.select_related("author")
            ],
            "submissions": [
                {"item": sub, "html": render_markdown(sub.body)}
                for sub in issue.submissions.select_related("author", "reviewer").prefetch_related(
                    "attachments"
                )
            ],
            "pending_requests": issue.assignment_requests.filter(state="pending").select_related(
                "user"
            ),
            "can_request": project.memberships.filter(user=request.user, role="member").exists()
            and not issue.assignees.filter(pk=request.user.pk).exists(),
            "active_statuses": project.statuses.filter(category="active", is_review=False),
            "done_statuses": project.statuses.filter(category="done"),
            "description_html": render_markdown(issue.description),
            **relation_data,
            "watching": issue.watchers.filter(pk=request.user.pk).exists(),
            "tag_suggestions": project.tags.order_by("name"),
            "editor_form": editor_form
            or (
                IssueForm(project=project, instance=issue, user=request.user)
                if can_edit_issue(request.user, issue)
                else None
            ),
            "editor_open": editor_form is not None or request.GET.get("edit") == "1",
            "preview": preview,
        },
        status=response_status,
    )


@login_required
@require_GET
def board_list(request):
    boards = Board.objects.filter(project__in=visible_projects(request.user)).select_related(
        "project"
    )
    return render(request, "projects/boards.html", {"boards": boards})


@require_GET
def api_projects(request, key=None, resource=None):
    if not request.user.is_authenticated:
        return JsonResponse({}, status=401)
    projects = visible_projects(request.user)
    if key is None:
        return JsonResponse({"projects": list(projects.values("key", "name", "description"))})
    project = get_object_or_404(projects, key=key)
    if resource == "issues":
        issues = project.issues.select_related("project", "status", "issue_type").prefetch_related(
            "tags"
        )
        return JsonResponse(
            {
                "issues": [
                    {
                        "id": issue.reference,
                        "title": issue.title,
                        "description": issue.description,
                        "status": {"name": issue.status.name, "category": issue.status.category},
                        "type": issue.issue_type.name,
                        "priority": issue.priority,
                        "estimate": issue.estimate,
                        "start_date": issue.start_date,
                        "due_date": issue.due_date,
                        "tags": [tag.name for tag in issue.tags.all()],
                        "version": issue.version,
                        "position": issue.position,
                        "assignees": list(issue.assignees.values("id", "username")),
                        "customers": list(issue.customers.values("id", "username")),
                        "watchers": list(issue.watchers.values("id", "username")),
                        "capabilities": {
                            "edit": can_edit_issue(request.user, issue),
                            "manage": is_manager(request.user, project),
                        },
                    }
                    for issue in issues
                ]
            }
        )
    return JsonResponse(
        {
            "project": {
                "key": project.key,
                "name": project.name,
                "description": project.description,
                "statuses": list(project.statuses.values("name", "category")),
                "types": list(project.issue_types.values("name", "color", "icon")),
                "boards": list(project.boards.values("name")),
            }
        }
    )


def can_edit(user, project):
    return is_manager(user, project)


def editable_project(request, key):
    project = get_object_or_404(visible_projects(request.user), key=key)
    if not can_edit(request.user, project):
        raise PermissionDenied
    return project


@login_required
@require_http_methods(["GET", "POST"])
def issue_edit(request, key, number=None):
    project = get_object_or_404(visible_projects(request.user), key=key)
    issue = get_object_or_404(Issue, project=project, number=number) if number else None
    if issue:
        if not can_edit_issue(request.user, issue):
            raise PermissionDenied
    else:
        require_manager(request.user, project)
    if issue and request.method == "GET":
        from django.urls import reverse

        return redirect(reverse("issue-detail", args=[key, number]) + "?edit=1")
    form = IssueForm(
        request.POST if request.method == "POST" else None,
        project=project,
        instance=issue,
        user=request.user,
    )
    preview = None
    status = 200
    if request.method == "POST":
        valid = form.is_valid()
        if request.POST.get("action") == "preview":
            preview = render_markdown(request.POST.get("description", "")[:50000])
            status = 200 if valid else 400
        elif valid:
            try:
                saved = form.save()
                return redirect("issue-detail", key=key, number=saved.number)
            except ValidationError as error:
                form.add_error(None, error)
                status = 400
            except ConflictError:
                form.add_error(
                    None,
                    _(
                        "This issue changed while you were editing. Your text is kept below. Open the latest version before saving again."
                    ),
                )
                status = 409
        else:
            status = 400
    if issue:
        return issue_detail(
            request, key, number, editor_form=form, preview=preview, response_status=status
        )
    return render(
        request,
        "projects/issue_form.html",
        {
            "project": project,
            "issue": issue,
            "form": form,
            "tag_suggestions": project.tags.order_by("name"),
            "preview": preview,
            "manager": is_manager(request.user, project),
        },
        status=status,
    )


@login_required
@require_http_methods(["GET", "POST"])
def issue_delete(request, key, number):
    project = editable_project(request, key)
    issue = get_object_or_404(Issue, project=project, number=number)
    error = None
    if request.method == "POST":
        if request.POST.get("confirm") != "yes":
            error = _("Confirm deletion to continue.")
        elif request.POST.get("version") != str(issue.version):
            error = _("This issue changed. Review the latest version before deleting it.")
        else:
            with transaction.atomic():
                lock_project(project)
                require_manager(request.user, project)
                # A conditional write locks the row before removing it and its tag links.
                locked = Issue.objects.filter(pk=issue.pk, version=issue.version).update(
                    version=F("version") + 1
                )
                if locked:
                    issue.delete()
                    return redirect("project-board", key=key)
            error = _("This issue changed. Review the latest version before deleting it.")
    return render(
        request,
        "projects/issue_delete.html",
        {"project": project, "issue": issue, "error": error},
        status=409 if error else 200,
    )


@login_required
@require_http_methods(["GET", "POST"])
def issue_types(request, key):
    project = editable_project(request, key)
    form = IssueTypeForm(
        request.POST if request.method == "POST" else None, instance=IssueType(project=project)
    )
    if request.method == "POST" and form.is_valid():
        try:
            with transaction.atomic():
                lock_project(project)
                require_manager(request.user, project)
                form.save()
            return redirect("issue-types", key=key)
        except IntegrityError:
            form.add_error("name", _("An issue type with this name already exists."))
    return render(
        request,
        "projects/types.html",
        {"project": project, "form": form, "types": project.issue_types.all()},
        status=400 if form.errors else 200,
    )
