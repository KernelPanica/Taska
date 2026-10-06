import hashlib
import secrets
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model, login
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import F
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .forms import ConflictError
from .models import (
    AssignmentRequest,
    Attachment,
    Comment,
    Invitation,
    Issue,
    Membership,
    Notification,
    Outbox,
    Profile,
    Status,
    Submission,
    next_issue_position,
)
from .team_forms import (
    AcceptInvitationForm,
    CommentForm,
    InviteForm,
    ParticipantsForm,
    ProfileForm,
    ProgressForm,
    StatusForm,
    VersionForm,
)
from .views import visible_projects
from .workflow import (
    EVENT_LABELS,
    can_edit_issue,
    is_manager,
    is_member,
    lock_issue,
    lock_project,
    managers,
    notify,
    require_manager,
    set_issue_status,
    transition_issue,
)


def problem(request, error, status=400, form=None):
    return render(
        request, "projects/action_error.html", {"error": error, "form": form}, status=status
    )


def posted_id(request, name):
    try:
        value = int(request.POST.get(name, ""))
        if value < 1 or value > 9223372036854775807:
            raise ValueError
        return value
    except (ValueError, TypeError):
        raise ValidationError(_("Choose a valid item.")) from None


def project_for(request, key):
    return get_object_or_404(visible_projects(request.user), key=key)


@require_GET
def my_tasks(request):
    issues = Issue.objects.filter(
        project__in=visible_projects(request.user), assignees=request.user
    ).select_related("project", "status", "issue_type")
    done = request.GET.get("status") == "done"
    issues = (
        issues.filter(status__category="done") if done else issues.exclude(status__category="done")
    )
    return render(request, "projects/my_tasks.html", {"issues": issues, "done": done})


@require_POST
def issue_action(request, key, number):
    project = project_for(request, key)
    issue = get_object_or_404(Issue, project=project, number=number)
    action = request.POST.get("action")
    version_form = VersionForm(request.POST)
    if not version_form.is_valid():
        return problem(request, _("Reload the task and try again."), form=version_form)
    stored_files = []
    try:
        with transaction.atomic():
            lock_issue(issue, version_form.cleaned_data["version"])
            # Membership may have been revoked since the page was opened.
            project_for(request, key)
            manager = is_manager(request.user, project)
            if action == "participants":
                require_manager(request.user, project)
                form = ParticipantsForm(request.POST, issue=issue)
                if not form.is_valid():
                    raise ValidationError(form.errors.as_text())
                previous = set(issue.assignees.values_list("pk", flat=True))
                for name in ("assignees", "customers", "watchers"):
                    getattr(issue, name).set(form.cleaned_data[name])
                notify(
                    issue,
                    request.user,
                    "participants",
                    previous | set(issue.assignees.values_list("pk", flat=True)),
                )
            elif action == "request_assignment":
                if (
                    not is_member(request.user, project)
                    or issue.assignees.filter(pk=request.user.pk).exists()
                ):
                    raise PermissionDenied
                assignment, created = AssignmentRequest.objects.get_or_create(
                    issue=issue, user=request.user, state="pending"
                )
                if created:
                    notify(issue, request.user, "assignment_requested", managers(project))
            elif action in {"assignment_approve", "assignment_reject"}:
                require_manager(request.user, project)
                item = get_object_or_404(
                    AssignmentRequest,
                    issue=issue,
                    pk=posted_id(request, "request_id"),
                    state="pending",
                )
                if action == "assignment_approve":
                    if not is_member(item.user, project) or not item.user.is_active:
                        raise ValidationError(
                            _("This person is no longer an active project member.")
                        )
                    issue.assignees.add(item.user)
                    item.state = "approved"
                else:
                    item.state = "rejected"
                item.save(update_fields=["state"])
                notify(issue, request.user, "assignment_" + item.state, [item.user_id])
            elif action == "watch":
                issue.watchers.add(request.user)
            elif action == "unwatch":
                issue.watchers.remove(request.user)
            elif action == "submit":
                if not can_edit_issue(request.user, issue) or issue.status.category != "active":
                    raise PermissionDenied
                form = ProgressForm(request.POST)
                if not form.is_valid():
                    raise ValidationError(form.errors.as_text())
                files = request.FILES.getlist("files")
                if not form.cleaned_data["body"].strip() and not files:
                    raise ValidationError(_("Add progress text or at least one file."))
                if (
                    any(f.size > settings.TASKA_FILE_LIMIT for f in files)
                    or sum(f.size for f in files) > settings.TASKA_SUBMISSION_LIMIT
                ):
                    raise ValidationError(
                        _("The upload exceeds the configured file or submission limit.")
                    )
                review = project.statuses.filter(is_review=True).first()
                if not review:
                    raise ValidationError(_("Ask a project manager to configure a review status."))
                submission = Submission.objects.create(
                    issue=issue,
                    author=request.user,
                    body=form.cleaned_data["body"],
                    issue_version=issue.version,
                )
                for uploaded in files:
                    attachment = Attachment(
                        submission=submission,
                        name=Path(uploaded.name).name[:255],
                        size=uploaded.size,
                    )
                    attachment.file.save(uuid4().hex, uploaded, save=False)
                    stored_files.append((attachment.file.storage, attachment.file.name))
                    attachment.save()
                set_issue_status(issue, review)
                notify(issue, request.user, "submitted", managers(project))
            elif action in {"approve", "return", "reopen", "start"}:
                target = get_object_or_404(Status, project=project, pk=posted_id(request, "status"))
                transition_issue(issue, request.user, target, action)
            elif action in {"comment", "comment_edit", "comment_delete"}:
                if action == "comment":
                    form = CommentForm(request.POST)
                    if not form.is_valid():
                        raise ValidationError(form.errors.as_text())
                    Comment.objects.create(
                        issue=issue, author=request.user, body=form.cleaned_data["body"]
                    )
                    kind = "comment"
                else:
                    comment = get_object_or_404(
                        Comment, issue=issue, pk=posted_id(request, "comment_id")
                    )
                    if comment.author_id != request.user.pk and (
                        action != "comment_delete" or not manager
                    ):
                        raise PermissionDenied
                    if str(comment.version) != request.POST.get("comment_version"):
                        raise ConflictError
                    if action == "comment_delete":
                        comment.delete()
                        kind = "comment_deleted"
                    else:
                        form = CommentForm(request.POST)
                        if not form.is_valid():
                            raise ValidationError(form.errors.as_text())
                        comment.body = form.cleaned_data["body"]
                        comment.version += 1
                        comment.save()
                        kind = "comment_edited"
                notify(issue, request.user, kind)
            else:
                raise ValidationError(_("Unknown action."))
    except (ValidationError, ConflictError) as error:
        for storage, name in stored_files:
            storage.delete(name)
        return problem(
            request,
            _("This task changed. Reload before trying again.")
            if isinstance(error, ConflictError)
            else "; ".join(error.messages),
            status=409 if isinstance(error, ConflictError) else 400,
        )
    except Exception:
        for storage, name in stored_files:
            storage.delete(name)
        raise
    return redirect("issue-detail", key=key, number=number)


@require_GET
def attachment_download(request, pk):
    attachment = get_object_or_404(
        Attachment.objects.select_related("submission__issue__project"),
        pk=pk,
        submission__issue__project__in=visible_projects(request.user),
    )
    try:
        response = FileResponse(
            attachment.file.open("rb"),
            as_attachment=True,
            filename=attachment.name,
            content_type="application/octet-stream",
        )
    except FileNotFoundError:
        raise Http404 from None
    response["X-Content-Type-Options"] = "nosniff"
    return response


def visible_people(user):
    from django.db.models import Q

    people = get_user_model().objects.all()
    if user.is_superuser:
        return people
    return people.filter(
        Q(pk=user.pk)
        | Q(membership__project__in=visible_projects(user))
        | Q(watched_issues__project__in=visible_projects(user))
    ).distinct()


@require_http_methods(["GET", "POST"])
def profile(request, pk=None):
    person = get_object_or_404(visible_people(request.user), pk=pk or request.user.pk)
    own = person.pk == request.user.pk
    record = Profile.objects.filter(user=person).first()
    if request.method == "POST" and not own:
        raise PermissionDenied
    form = (
        ProfileForm(
            request.POST if request.method == "POST" else None,
            request.FILES if request.method == "POST" else None,
            instance=person,
            initial={"bio": record.bio if record else ""},
        )
        if own
        else None
    )
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            form.save()
            values = {"bio": form.cleaned_data["bio"]}
            if form.cleaned_data["remove_avatar"]:
                values["avatar"] = b""
            elif form.cleaned_data["avatar"] is not None:
                values["avatar"] = form.cleaned_data["avatar"]
            Profile.objects.update_or_create(user=person, defaults=values)
        messages.success(request, _("Profile saved."))
        return redirect("profile")
    return render(
        request,
        "projects/profile.html",
        {"person": person, "record": record, "form": form},
        status=400 if form and form.errors else 200,
    )


@require_GET
def avatar(request, pk):
    from html import escape

    person = get_object_or_404(visible_people(request.user), pk=pk)
    data = Profile.objects.filter(user=person).values_list("avatar", flat=True).first()
    if data:
        response = HttpResponse(bytes(data), content_type="image/png")
    else:
        initial = escape((person.get_full_name() or person.username)[:1].upper())
        response = HttpResponse(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#23385f"/><text x="32" y="43" text-anchor="middle" font-size="32" font-family="sans-serif" fill="#dbe5ff">{initial}</text></svg>',
            content_type="image/svg+xml",
        )
    response["X-Content-Type-Options"] = "nosniff"
    return response


@require_http_methods(["GET", "POST"])
def notifications(request):
    items = Notification.objects.filter(
        user=request.user, issue__project__in=visible_projects(request.user)
    ).select_related("issue__project", "actor")
    if request.method == "POST":
        try:
            notification_id = posted_id(request, "notification_id")
        except ValidationError as error:
            return problem(request, "; ".join(error.messages))
        items.filter(pk=notification_id).update(read=True)
        return redirect("notifications")
    return render(
        request,
        "projects/notifications.html",
        {
            "events": [
                {"item": item, "label": EVENT_LABELS.get(item.kind, item.kind)}
                for item in items[:100]
            ]
        },
    )


@require_http_methods(["GET", "POST"])
def statuses(request, key):
    project = project_for(request, key)
    require_manager(request.user, project)
    selected = request.POST.get("status_id") or request.GET.get("edit")
    if selected and not selected.isdecimal():
        return problem(request, _("Choose a valid item."))
    instance = (
        get_object_or_404(Status, project=project, pk=selected)
        if selected
        else Status(project=project)
    )
    form = StatusForm(
        request.POST if request.method == "POST" else None,
        instance=instance,
        initial={"version": project.version},
    )
    if request.method == "POST":
        version = VersionForm(request.POST)
        if not version.is_valid():
            return problem(request, _("Reload the page and try again."))
        try:
            with transaction.atomic():
                lock_project(project, version.cleaned_data["version"])
                require_manager(request.user, project)
                if request.POST.get("action") in {"left", "right"}:
                    ordered = list(project.statuses.all())
                    index = next(
                        (i for i, item in enumerate(ordered) if item.pk == instance.pk), None
                    )
                    if index is None:
                        raise ValidationError(_("Choose a status."))
                    target = index + (-1 if request.POST["action"] == "left" else 1)
                    if 0 <= target < len(ordered):
                        ordered[index], ordered[target] = ordered[target], ordered[index]
                    for position, item in enumerate(ordered):
                        item.position = position
                    Status.objects.bulk_update(ordered, ["position"])
                    return redirect("project-statuses", key=key)
                if request.POST.get("action") == "delete":
                    if not instance.pk:
                        raise ValidationError(_("Choose a status."))
                    if not instance.issues.exists() and not request.POST.get("replacement"):
                        instance.delete()
                        return redirect("project-statuses", key=key)
                    replacement = get_object_or_404(
                        Status, project=project, pk=posted_id(request, "replacement")
                    )
                    if replacement.pk == instance.pk or replacement.category != instance.category:
                        raise ValidationError(
                            _("Choose a different replacement in the same category.")
                        )
                    if instance.is_review:
                        if replacement.issues.exists():
                            raise ValidationError(
                                _("Choose an empty active status as the new review status.")
                            )
                        Status.objects.filter(pk=instance.pk).update(is_review=False)
                        Status.objects.filter(pk=replacement.pk).update(is_review=True)
                    elif replacement.is_review:
                        raise ValidationError(
                            _("Tasks must enter review through a progress submission.")
                        )
                    for issue in instance.issues.select_related("project"):
                        notify(issue, request.user, "status")
                    instance.issues.update(
                        status=replacement,
                        position=F("position") + next_issue_position(project.pk, replacement.pk),
                        version=F("version") + 1,
                    )
                    instance.delete()
                    return redirect("project-statuses", key=key)
                if not form.is_valid():
                    raise ValidationError(form.errors.as_text())
                original = Status.objects.get(pk=instance.pk) if instance.pk else None
                if (
                    original
                    and (
                        original.category != form.cleaned_data["category"]
                        or original.is_review != form.cleaned_data["is_review"]
                    )
                    and original.issues.exists()
                ):
                    raise ValidationError(
                        _("Move tasks before changing this status category or review role.")
                    )
                if not instance.pk:
                    from django.db.models import Max

                    last = project.statuses.aggregate(value=Max("position"))["value"]
                    form.instance.position = 0 if last is None else last + 1
                form.save()
                return redirect("project-statuses", key=key)
        except ConflictError:
            return problem(request, _("Project settings changed. Reload before trying again."), 409)
        except (ValidationError, IntegrityError) as error:
            form.add_error(
                None,
                "; ".join(error.messages)
                if isinstance(error, ValidationError)
                else _("This status conflicts with an existing status."),
            )
    columns = list(project.statuses.all())
    for column in columns:
        column.edit_form = StatusForm(
            instance=column, initial={"version": project.version}, auto_id=f"column-{column.pk}-%s"
        )
    return render(
        request,
        "projects/statuses.html",
        {
            "project": project,
            "form": form,
            "editing": instance if instance.pk else None,
            "statuses": columns,
        },
        status=400 if form.errors else 200,
    )


@require_http_methods(["GET", "POST"])
def team(request, key):
    project = project_for(request, key)
    require_manager(request.user, project)
    form = InviteForm(
        request.POST if request.method == "POST" else None, initial={"version": project.version}
    )
    invitation_link = None
    if request.method == "POST":
        version = VersionForm(request.POST)
        if not version.is_valid():
            return problem(request, _("Reload the page and try again."))
        try:
            with transaction.atomic():
                lock_project(project, version.cleaned_data["version"])
                require_manager(request.user, project)
                action = request.POST.get("action")
                if action in {"remove", "role"}:
                    membership = get_object_or_404(
                        Membership, project=project, pk=posted_id(request, "membership_id")
                    )
                    if membership.role == "manager" and not request.user.is_superuser:
                        raise PermissionDenied
                    if membership.role == "manager" and (
                        action == "remove" or request.POST.get("role") != "manager"
                    ):
                        Invitation.objects.filter(
                            project=project, created_by=membership.user, consumed_at=None
                        ).update(revoked=True)
                    if action == "remove":
                        for issue in project.issues.all():
                            issue.assignees.remove(membership.user)
                            issue.customers.remove(membership.user)
                            issue.watchers.remove(membership.user)
                        project.issues.update(version=F("version") + 1)
                        AssignmentRequest.objects.filter(
                            issue__project=project, user=membership.user, state="pending"
                        ).update(state="rejected")
                        membership.delete()
                    else:
                        role = request.POST.get("role")
                        if role not in {"member", "observer", "manager"} or (
                            role == "manager" and not request.user.is_superuser
                        ):
                            raise PermissionDenied
                        membership.role = role
                        membership.save()
                        if role == "observer":
                            for issue in project.issues.filter(assignees=membership.user):
                                issue.assignees.remove(membership.user)
                                Issue.objects.filter(pk=issue.pk).update(version=F("version") + 1)
                    return redirect("project-team", key=key)
                if action == "revoke":
                    invitation = get_object_or_404(
                        Invitation, project=project, pk=posted_id(request, "invitation_id")
                    )
                    invitation.revoked = True
                    invitation.save(update_fields=["revoked"])
                    return redirect("project-team", key=key)
                if not form.is_valid():
                    raise ValidationError(form.errors.as_text())
                token = secrets.token_urlsafe(32)
                invitation = Invitation.objects.create(
                    project=project,
                    email=form.cleaned_data["email"].lower(),
                    role=form.cleaned_data["role"],
                    token_hash=hashlib.sha256(token.encode()).hexdigest(),
                    created_by=request.user,
                    expires_at=timezone.now() + timedelta(days=7),
                )
                invitation_link = settings.TASKA_PUBLIC_URL + reverse("invite-accept", args=[token])
                if settings.TASKA_EMAIL_ENABLED:
                    Outbox.objects.create(
                        invitation=invitation, invitation_token=token, available_at=timezone.now()
                    )
                form = InviteForm(initial={"version": project.version})
        except ConflictError:
            return problem(request, _("Project settings changed. Reload before trying again."), 409)
        except ValidationError as error:
            form.add_error(None, error)
    return render(
        request,
        "projects/team.html",
        {
            "project": project,
            "form": form,
            "invitation_link": invitation_link,
            "memberships": project.memberships.select_related("user"),
            "invitations": Invitation.objects.filter(
                project=project, consumed_at=None, revoked=False, expires_at__gt=timezone.now()
            ),
        },
        status=400 if form.errors else 200,
    )


@require_http_methods(["GET", "POST"])
def invite_accept(request, token):
    invitation = get_object_or_404(
        Invitation,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        consumed_at=None,
        revoked=False,
        expires_at__gt=timezone.now(),
    )
    existing = get_user_model().objects.filter(email__iexact=invitation.email).exists()
    form = AcceptInvitationForm(request.POST if request.method == "POST" else None)
    error = None
    if request.method == "POST":
        try:
            with transaction.atomic():
                lock_project(invitation.project)
                if not invitation.created_by.is_active or not is_manager(
                    invitation.created_by, invitation.project
                ):
                    raise Http404
                if not Invitation.objects.filter(
                    pk=invitation.pk, consumed_at=None, revoked=False, expires_at__gt=timezone.now()
                ).update(consumed_at=timezone.now()):
                    raise Http404
                if request.user.is_authenticated:
                    if request.user.email.lower() != invitation.email.lower():
                        raise PermissionDenied
                    user = request.user
                elif get_user_model().objects.filter(email__iexact=invitation.email).exists():
                    raise ValidationError(_("Sign in with the account matching this invitation."))
                else:
                    if not form.is_valid():
                        raise ValidationError(form.errors.as_text())
                    user = form.save(commit=False)
                    user.email = invitation.email
                    user.save()
                Membership.objects.get_or_create(
                    project=invitation.project, user=user, defaults={"role": invitation.role}
                )
            if not request.user.is_authenticated:
                login(request, user)
            return redirect("project-board", key=invitation.project.key)
        except ValidationError as exc:
            error = "; ".join(exc.messages)
    return render(
        request,
        "registration/invitation.html",
        {"form": form, "existing": existing, "error": error},
        status=400 if error else 200,
    )
