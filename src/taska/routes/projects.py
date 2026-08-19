from pathlib import Path
from datetime import date, datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import select

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.configuration import WipLimit
from taska.models.project import Sprint, SprintSnapshot, Task, TaskAttachment
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.profiles import list_all_tags
from taska.services.projects import (
    add_task_progress,
    assign_task_to_sprint,
    apply_for_task,
    approve_application,
    create_project,
    create_sprint,
    create_project_status,
    create_task,
    get_project,
    get_project_statuses,
    get_task,
    is_pm,
    list_projects,
    pending_applications_for_task,
    record_sprint_snapshot,
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


@router.post("/projects/{project_id}/sprints")
def create_sprint_submit(
    project_id: int,
    name: str = Form(...),
    goal: str = Form(""),
    start_date: date = Form(...),
    end_date: date = Form(...),
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
        create_sprint(
            db,
            current,
            project,
            name=name,
            goal=goal,
            start_date=start_date,
            end_date=end_date,
        )
    except ValueError as exc:
        return RedirectResponse(
            f"/projects/{project_id}/sprints?error={quote(str(exc))}", status_code=303
        )
    return RedirectResponse(
        f"/projects/{project_id}/sprints?success={quote('Спринт создан')}", status_code=303
    )


@router.get("/projects/{project_id}/sprints", response_class=HTMLResponse)
def project_sprints(
    request: Request,
    project_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    error: str | None = None,
    success: str | None = None,
    sprint_id: int | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    project = get_project(db, project_id)
    if project is None:
        return RedirectResponse("/projects", status_code=303)
    statuses = get_project_statuses(db, project.id)
    done_codes = {code for code, label in statuses.items() if code in {"done", "closed", "completed"} or "готов" in label.lower() or "закры" in label.lower()}
    selected_sprint = next((s for s in project.sprints if s.id == sprint_id), None)
    active_sprint = next((s for s in project.sprints if s.status == "active"), None)
    selected_sprint = selected_sprint or active_sprint or (project.sprints[-1] if project.sprints else None)
    if selected_sprint:
        record_sprint_snapshot(db, selected_sprint.id)
        db.commit()
    totals = {code: 0 for code in statuses}
    scoped_tasks = selected_sprint.tasks if selected_sprint else project.tasks
    for task in scoped_tasks:
        totals[task.status] = totals.get(task.status, 0) + 1
    done_count = sum(totals.get(code, 0) for code in done_codes)
    total = len(scoped_tasks)
    total_points = sum(task.story_points or 0 for task in scoped_tasks)
    done_points = sum(task.story_points or 0 for task in scoped_tasks if task.status in done_codes)
    backlog = [task for task in project.tasks if task.sprint_id is None]
    workload = {}
    for task in scoped_tasks:
        name = task.assignee.display_name or task.assignee.username if task.assignee else "Не назначено"
        item = workload.setdefault(name, {"tasks": 0, "points": 0})
        item["tasks"] += 1; item["points"] += task.story_points or 0
    velocity = []
    for sprint in [s for s in project.sprints if s.status == "completed"][-6:]:
        velocity.append({"name": sprint.name, "points": sum(t.story_points or 0 for t in sprint.tasks if t.status in done_codes)})
    max_velocity = max(1, max((item["points"] for item in velocity), default=0))
    burndown = []
    if selected_sprint:
        days = max(1, (selected_sprint.end_date - selected_sprint.start_date).days)
        sample_step = max(1, (days + 29) // 30)
        snapshots = {s.recorded_on: s for s in selected_sprint.snapshots}
        remaining_points = total_points
        offsets = list(range(0, days + 1, sample_step))
        if offsets[-1] != days:
            offsets.append(days)
        for offset in offsets:
            day = selected_sprint.start_date + timedelta(days=offset)
            available = [snapshot for recorded_on, snapshot in snapshots.items() if recorded_on <= day]
            if available:
                remaining_points = max(available, key=lambda snapshot: snapshot.recorded_on).remaining_points
            burndown.append({"day": day, "actual": remaining_points, "ideal": round(total_points * (1 - offset / days), 1)})
    max_burn = max([total_points, 1])
    wip_limits = {item.status: item.limit for item in db.scalars(select(WipLimit).where(WipLimit.project_id == project.id)).all()}
    return templates.TemplateResponse(request, "projects/sprints.html", {
        "user": current, "project": project, "site": get_site_context(db),
        "is_pm": is_pm(current), "statuses": statuses, "totals": totals,
        "total_tasks": total, "done_count": done_count,
        "completion": round(done_points / total_points * 100) if total_points else (round(done_count / total * 100) if total else 0),
        "total_points": total_points, "done_points": done_points, "backlog": backlog,
        "selected_sprint": selected_sprint, "active_sprint": active_sprint,
        "workload": workload, "velocity": velocity, "max_velocity": max_velocity,
        "burndown": burndown, "max_burn": max_burn, "done_codes": done_codes,
        "wip_limits": wip_limits,
        "error": unquote(error) if error else None, "success": unquote(success) if success else None,
    })


@router.get("/projects/{project_id}/sprints/{sprint_id}", response_class=HTMLResponse)
def sprint_detail(request: Request, project_id: int, sprint_id: int, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    return project_sprints(request, project_id, user, db, sprint_id=sprint_id)


@router.post("/projects/{project_id}/tasks/{task_id}/planning")
def plan_task(project_id: int, task_id: int, sprint_id: int | None = Form(None), story_points: int = Form(0), priority: str = Form("medium"), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    current = _require_login(user)
    if isinstance(current, RedirectResponse): return current
    task = get_task(db, task_id)
    sprint = db.get(Sprint, sprint_id) if sprint_id else None
    if task is None or task.project_id != project_id: return RedirectResponse("/projects", status_code=303)
    try:
        if story_points < 0 or story_points > 100: raise ValueError("Story Points должны быть от 0 до 100")
        if priority not in {"low", "medium", "high", "critical"}: raise ValueError("Неизвестный приоритет")
        task.story_points, task.priority = story_points, priority
        assign_task_to_sprint(db, current, task, sprint)
    except ValueError as exc:
        return RedirectResponse(f"/projects/{project_id}/sprints?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(f"/projects/{project_id}/sprints?success={quote('План задачи обновлён')}", status_code=303)


@router.post("/projects/{project_id}/sprints/{sprint_id}/state")
def change_sprint_state(project_id: int, sprint_id: int, action: str = Form(...), next_sprint_id: int | None = Form(None), retrospective: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    current = _require_login(user)
    if isinstance(current, RedirectResponse): return current
    sprint = db.get(Sprint, sprint_id)
    if sprint is None or sprint.project_id != project_id or not is_pm(current): return RedirectResponse("/projects", status_code=303)
    if action == "start":
        active = db.scalar(select(Sprint).where(Sprint.project_id == project_id, Sprint.status == "active", Sprint.id != sprint.id))
        if active: return RedirectResponse(f"/projects/{project_id}/sprints?error={quote('Сначала завершите активный спринт')}", status_code=303)
        sprint.status = "active"
    elif action == "complete":
        target = db.get(Sprint, next_sprint_id) if next_sprint_id else None
        final_total_points = sum(task.story_points or 0 for task in sprint.tasks)
        for task in sprint.tasks:
            if task.status not in {"done", "closed", "completed"}: task.sprint_id = target.id if target and target.project_id == project_id else None
        sprint.status = "completed"; sprint.completed_at = datetime.now(timezone.utc); sprint.retrospective = retrospective.strip()
        snapshot = db.scalar(select(SprintSnapshot).where(SprintSnapshot.sprint_id == sprint.id, SprintSnapshot.recorded_on == date.today()))
        if snapshot is None:
            snapshot = SprintSnapshot(sprint_id=sprint.id, recorded_on=date.today())
            db.add(snapshot)
        snapshot.total_points = final_total_points
        snapshot.remaining_points = 0
    else: return RedirectResponse(f"/projects/{project_id}/sprints?error={quote('Неизвестное действие')}", status_code=303)
    if action == "start":
        record_sprint_snapshot(db, sprint.id)
    db.commit()
    return RedirectResponse(f"/projects/{project_id}/sprints/{sprint.id}?success={quote('Спринт обновлён')}", status_code=303)


@router.post("/projects/{project_id}/wip-limits")
def set_wip_limit(project_id: int, status: str = Form(...), limit: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    current = _require_login(user)
    if isinstance(current, RedirectResponse): return current
    if not is_pm(current) or status not in get_project_statuses(db, project_id): return RedirectResponse("/projects", status_code=303)
    try:
        parsed_limit = int(limit) if limit.strip() else 0
    except ValueError:
        return RedirectResponse(f"/projects/{project_id}/sprints?error={quote('WIP-лимит должен быть числом')}", status_code=303)
    item = db.scalar(select(WipLimit).where(WipLimit.project_id == project_id, WipLimit.status == status))
    if parsed_limit <= 0:
        if item: db.delete(item)
    elif item: item.limit = parsed_limit
    else: db.add(WipLimit(project_id=project_id, status=status, limit=parsed_limit))
    db.commit()
    return RedirectResponse(f"/projects/{project_id}/sprints?success={quote('WIP-лимит обновлён')}", status_code=303)


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
    return_to: str = Form("task"),
    ajax: str = Form("0"),
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
        if return_to == "board":
            if ajax == "1":
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
            return RedirectResponse(
                f"/projects/{project_id}/board?error={quote(str(exc))}",
                status_code=303,
            )
        return RedirectResponse(
            f"/projects/{project_id}/tasks/{task_id}?error={quote(str(exc))}",
            status_code=303,
        )

    if return_to == "board":
        if ajax == "1":
            return JSONResponse({"ok": True, "task_id": task.id, "status": status})
        return RedirectResponse(
            f"/projects/{project_id}/board?success={quote('Статус обновлён')}",
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
    sprint_id: int | None = None,
    assignee_id: int | None = None,
    tag_id: int | None = None,
    priority: str | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    project = get_project(db, project_id)
    if project is None:
        return RedirectResponse("/projects", status_code=303)
    statuses = get_project_statuses(db, project.id)
    columns = {code: [] for code in statuses}
    filtered_tasks = project.tasks
    if sprint_id is not None: filtered_tasks = [t for t in filtered_tasks if t.sprint_id == sprint_id]
    if assignee_id is not None: filtered_tasks = [t for t in filtered_tasks if t.assignee_id == assignee_id]
    if tag_id is not None: filtered_tasks = [t for t in filtered_tasks if any(tag.id == tag_id for tag in t.required_tags)]
    if priority: filtered_tasks = [t for t in filtered_tasks if t.priority == priority]
    for task in filtered_tasks:
        columns.setdefault(task.status, []).append(task)
    wip_limits = {item.status: item.limit for item in db.scalars(select(WipLimit).where(WipLimit.project_id == project.id)).all()}
    assignees = sorted({t.assignee.id: t.assignee for t in project.tasks if t.assignee}.values(), key=lambda u: (u.display_name or u.username).lower())
    tags = sorted({tag.id: tag for t in project.tasks for tag in t.required_tags}.values(), key=lambda tag: tag.name.lower())
    return templates.TemplateResponse(
        request,
        "projects/board.html",
        {
            "user": current,
            "site": get_site_context(db),
            "project": project,
            "statuses": statuses,
            "columns": columns,
            "filtered_count": len(filtered_tasks), "wip_limits": wip_limits,
            "assignees": assignees, "filter_tags": tags,
            "filter_sprint_id": sprint_id, "filter_assignee_id": assignee_id,
            "filter_tag_id": tag_id, "filter_priority": priority,
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
