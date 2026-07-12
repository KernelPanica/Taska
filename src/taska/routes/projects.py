from pathlib import Path
from urllib.parse import quote, unquote

from typing import Annotated

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.constants import TASK_STATUSES
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.profiles import list_all_tags
from taska.services.projects import (
    apply_for_task,
    approve_application,
    create_project,
    create_task,
    get_project,
    get_task,
    is_pm,
    list_projects,
    pending_applications_for_task,
    reject_application,
    update_task_status,
    user_has_required_tags,
)

router = APIRouter(tags=["projects"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _require_login(user: User | None) -> User | RedirectResponse:
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return user


@router.get("/projects", response_class=HTMLResponse)
def projects_list(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    projects = list_projects(db)
    site = get_site_context(db)
    return templates.TemplateResponse(
        request,
        "projects/list.html",
        {
            "user": current,
            "projects": projects,
            "site": site,
            "is_pm": is_pm(current),
        },
    )


@router.post("/projects")
def create_project_submit(
    name: str = Form(...),
    description: str = Form(""),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    try:
        project = create_project(db, current, name=name, description=description)
    except ValueError as exc:
        return RedirectResponse(f"/projects?error={quote(str(exc))}", status_code=303)

    return RedirectResponse(f"/projects/{project.id}", status_code=303)


@router.get("/projects/{project_id}", response_class=HTMLResponse)
def project_detail(
    request: Request,
    project_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    error: str | None = None,
    success: str | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    project = get_project(db, project_id)
    if project is None:
        return RedirectResponse("/projects", status_code=303)

    site = get_site_context(db)
    return templates.TemplateResponse(
        request,
        "projects/detail.html",
        {
            "user": current,
            "project": project,
            "site": site,
            "is_pm": is_pm(current),
            "statuses": TASK_STATUSES,
            "all_tags": list_all_tags(db) if is_pm(current) else [],
            "error": unquote(error) if error else None,
            "success": unquote(success) if success else None,
        },
    )


@router.post("/projects/{project_id}/tasks")
def create_task_submit(
    project_id: int,
    title: str = Form(...),
    description: str = Form(""),
    enforce_single_task: str | None = Form(None),
    required_tag_ids: Annotated[list[int], Form()] = [],
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    project = get_project(db, project_id)
    if project is None:
        return RedirectResponse("/projects", status_code=303)

    try:
        task = create_task(
            db,
            current,
            project,
            title=title,
            description=description,
            enforce_single_task=enforce_single_task == "on",
            required_tag_ids=required_tag_ids,
        )
    except ValueError as exc:
        return RedirectResponse(f"/projects/{project_id}?error={quote(str(exc))}", status_code=303)

    return RedirectResponse(f"/projects/{project_id}/tasks/{task.id}", status_code=303)


@router.get("/projects/{project_id}/tasks/{task_id}", response_class=HTMLResponse)
def task_detail(
    request: Request,
    project_id: int,
    task_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    error: str | None = None,
    success: str | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    task = get_task(db, task_id)
    if task is None or task.project_id != project_id:
        return RedirectResponse(f"/projects/{project_id}", status_code=303)

    site = get_site_context(db)
    can_apply = (
        not current.is_admin
        and task.status == "unassigned"
        and task.assignee_id is None
        and user_has_required_tags(current, task)
    )

    return templates.TemplateResponse(
        request,
        "projects/task_detail.html",
        {
            "user": current,
            "task": task,
            "project": task.project,
            "site": site,
            "is_pm": is_pm(current),
            "statuses": TASK_STATUSES,
            "can_apply": can_apply,
            "pending_applications": pending_applications_for_task(db, task.id)
            if is_pm(current)
            else [],
            "error": unquote(error) if error else None,
            "success": unquote(success) if success else None,
        },
    )


@router.post("/projects/{project_id}/tasks/{task_id}/apply")
def apply_task(
    project_id: int,
    task_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    task = get_task(db, task_id)
    if task is None or task.project_id != project_id:
        return RedirectResponse("/projects", status_code=303)

    try:
        apply_for_task(db, current, task)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Заявка отправлена PM')}",
        status_code=303,
    )


@router.post("/projects/{project_id}/tasks/{task_id}/applications/{application_id}/approve")
def approve_task_application(
    project_id: int,
    task_id: int,
    application_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    from taska.models.project import TaskApplication

    application = db.get(TaskApplication, application_id)
    if application is None or application.task_id != task_id:
        return RedirectResponse(f"/projects/{project_id}/tasks/{task_id}", status_code=303)

    try:
        approve_application(db, current, application)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Заявка одобрена, задача в работе')}",
        status_code=303,
    )


@router.post("/projects/{project_id}/tasks/{task_id}/applications/{application_id}/reject")
def reject_task_application(
    project_id: int,
    task_id: int,
    application_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    from taska.models.project import TaskApplication

    application = db.get(TaskApplication, application_id)
    if application is None or application.task_id != task_id:
        return RedirectResponse(f"/projects/{project_id}/tasks/{task_id}", status_code=303)

    try:
        reject_application(db, current, application)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Заявка отклонена')}",
        status_code=303,
    )


@router.post("/projects/{project_id}/tasks/{task_id}/status")
def change_task_status(
    project_id: int,
    task_id: int,
    status: str = Form(...),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    task = get_task(db, task_id)
    if task is None or task.project_id != project_id:
        return RedirectResponse("/projects", status_code=303)

    try:
        update_task_status(db, current, task, status)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Статус обновлён')}",
        status_code=303,
    )
