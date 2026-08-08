from pathlib import Path
from typing import Annotated
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.project import TaskAttachment
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.profiles import list_all_tags
from taska.services.projects import (
    add_task_progress,
    apply_for_task,
    approve_application,
    create_project,
    create_project_status,
    create_task,
    get_project,
    get_project_statuses,
    get_task,
    is_pm,
    list_projects,
    pending_applications_for_task,
    reject_application,
    request_task_status,
    review_status_request,
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
            "statuses": get_project_statuses(db, project.id),
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
            "statuses": get_project_statuses(db, task.project_id),
            "can_apply": can_apply,
            "pending_applications": pending_applications_for_task(db, task.id)
            if is_pm(current)
            else [],
            "progress_updates": sorted(
                task.progress_updates, key=lambda item: item.created_at, reverse=True
            ),
            "status_requests": sorted(
                task.status_requests, key=lambda item: item.created_at, reverse=True
            ),
            "can_post_progress": task.assignee_id == current.id or is_pm(current),
            "can_request_status": task.assignee_id == current.id,
            "attachments": sorted(task.attachments, key=lambda item: item.created_at, reverse=True),
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
        f"/projects/{project_id}/tasks/{task_id}"
        f"?success={quote('Заявка одобрена, задача в работе')}",
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


@router.get("/projects/{project_id}/board", response_class=HTMLResponse)
def project_board(
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
    statuses = get_project_statuses(db, project.id)
    columns = {code: [] for code in statuses}
    for task in project.tasks:
        columns.setdefault(task.status, []).append(task)
    return templates.TemplateResponse(
        request,
        "projects/board.html",
        {
            "user": current,
            "site": get_site_context(db),
            "project": project,
            "statuses": statuses,
            "columns": columns,
            "is_pm": is_pm(current),
            "error": unquote(error) if error else None,
            "success": unquote(success) if success else None,
        },
    )


@router.post("/projects/{project_id}/statuses")
def add_project_status(
    project_id: int,
    name: str = Form(...),
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
        create_project_status(db, current, project, name=name)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/board?error={quote(str(exc))}", status_code=303
        )
    return RedirectResponse(
        f"/projects/{project_id}/board?success={quote('Статус добавлен')}", status_code=303
    )


@router.post("/projects/{project_id}/tasks/{task_id}/attachments")
async def upload_task_attachment(
    project_id: int,
    task_id: int,
    attachment: UploadFile = File(...),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    task = get_task(db, task_id)
    if (
        task is None
        or task.project_id != project_id
        or (task.assignee_id != current.id and not is_pm(current))
    ):
        return RedirectResponse(f"/projects/{project_id}/tasks/{task_id}", status_code=303)
    allowed = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}
    if attachment.content_type not in allowed:
        message = quote("Поддерживаются изображения и PDF")
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={message}", status_code=303
        )
    data = await attachment.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        message = quote("Файл не должен быть больше 5 МБ")
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={message}", status_code=303
        )
    db.add(
        TaskAttachment(
            task_id=task.id,
            uploaded_by_id=current.id,
            filename=attachment.filename or "file",
            mime_type=attachment.content_type,
            data=data,
        )
    )
    db.commit()
    message = quote("Файл прикреплён")
    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={message}", status_code=303
    )


@router.get("/task-attachments/{attachment_id}")
def task_attachment(
    attachment_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    item = db.get(TaskAttachment, attachment_id)
    if item is None:
        return Response(status_code=404)
    return Response(
        item.data,
        media_type=item.mime_type,
        headers={"Content-Disposition": f'inline; filename="{item.filename}"'},
    )


@router.post("/projects/{project_id}/tasks/{task_id}/progress")
def publish_task_progress(
    project_id: int,
    task_id: int,
    body: str = Form(...),
    percent: int | None = Form(None),
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
        add_task_progress(db, current, task, body=body, percent=percent)
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )
    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Прогресс опубликован')}",
        status_code=303,
    )


@router.post("/projects/{project_id}/tasks/{task_id}/status-request")
def create_status_request(
    project_id: int,
    task_id: int,
    requested_status: str = Form(...),
    message: str = Form(""),
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
        request_task_status(
            db, current, task, requested_status=requested_status, message=message
        )
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )
    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Запрос отправлен всем PM')}",
        status_code=303,
    )


@router.post(
    "/projects/{project_id}/tasks/{task_id}/status-requests/{request_id}/{decision}"
)
def decide_status_request(
    project_id: int,
    task_id: int,
    request_id: int,
    decision: str,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    from taska.models.project import TaskStatusRequest

    status_request = db.get(TaskStatusRequest, request_id)
    if status_request is None or status_request.task_id != task_id or decision not in {
        "approve",
        "reject",
    }:
        return RedirectResponse(f"/projects/{project_id}/tasks/{task_id}", status_code=303)
    try:
        review_status_request(db, current, status_request, approve=decision == "approve")
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )
    return RedirectResponse(
        f"/projects/{project_id}/tasks/{task_id}?success={quote('Запрос обработан')}",
        status_code=303,
    )
