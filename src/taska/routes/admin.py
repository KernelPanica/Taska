from pathlib import Path

from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_admin_stats, get_site_context
from taska.services.invitation import create_invitation, list_invitations
from taska.services.admin_settings import (
    ENV_FIELDS,
    env_file_path,
    read_env_values,
    set_administrator,
    update_env_values,
)

router = APIRouter(prefix="/admin", tags=["admin"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _require_admin(user: User | None) -> User | RedirectResponse:
    if user is None or not user.is_admin:
        return RedirectResponse("/login", status_code=303)
    return user


@router.get("", response_class=HTMLResponse)
def admin_dashboard(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    stats = get_admin_stats(db)
    site = get_site_context(db)
    return templates.TemplateResponse(
        request,
        "admin/dashboard.html",
        {"user": admin, "stats": stats, "site": site},
    )


@router.get("/invitations", response_class=HTMLResponse)
def invitations_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    created: str | None = None,
):
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    site = get_site_context(db)
    invitations = list_invitations(db)
    invite_links = [
        {
            "invitation": inv,
            "url": f"{site['base_url']}/invite/{inv.token}",
        }
        for inv in invitations
    ]

    return templates.TemplateResponse(
        request,
        "admin/invitations.html",
        {
            "user": admin,
            "invitations": invite_links,
            "created": created,
            "site": site,
        },
    )


@router.post("/invitations")
def create_invitation_link(
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    invitation = create_invitation(db, admin)
    return RedirectResponse(f"/admin/invitations?created={invitation.token}", status_code=303)


@router.get("/settings", response_class=HTMLResponse)
def settings_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    success: str | None = None,
    error: str | None = None,
):
    current = _require_admin(user)
    if isinstance(current, RedirectResponse):
        return current
    users = list(db.query(User).order_by(User.username).all())
    return templates.TemplateResponse(request, "admin/settings.html", {
        "user": current, "site": get_site_context(db), "users": users,
        "env_fields": ENV_FIELDS, "env_values": read_env_values(),
        "env_path": str(env_file_path()),
        "success": unquote(success) if success else None,
        "error": unquote(error) if error else None,
    })


@router.post("/settings/environment")
async def update_environment(
    request: Request,
    user: User | None = Depends(get_current_user),
):
    current = _require_admin(user)
    if isinstance(current, RedirectResponse):
        return current
    form = await request.form()
    existing = read_env_values()
    updates: dict[str, str] = {}
    for key, (_, field_type) in ENV_FIELDS.items():
        if field_type == "boolean":
            updates[key] = "true" if form.get(key) == "on" else "false"
        else:
            value = str(form.get(key, "")).strip()
            updates[key] = existing.get(key, "") if field_type == "password" and not value else value
    try:
        update_env_values(updates)
    except (OSError, ValueError) as exc:
        return RedirectResponse(f"/admin/settings?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(
        f"/admin/settings?success={quote('Настройки сохранены. Пересоздайте контейнер для применения')}",
        status_code=303,
    )


@router.post("/users/{user_id}/administrator")
def update_administrator(
    user_id: int,
    enabled: str = Form("0"),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _require_admin(user)
    if isinstance(current, RedirectResponse):
        return current
    target = db.get(User, user_id)
    if target is None:
        return RedirectResponse("/admin/settings?error=Пользователь+не+найден", status_code=303)
    try:
        set_administrator(db, current, target, enabled == "1")
    except ValueError as exc:
        return RedirectResponse(f"/admin/settings?error={quote(str(exc))}", status_code=303)
    message = "Права администратора выданы" if enabled == "1" else "Права администратора сняты"
    return RedirectResponse(f"/admin/settings?success={quote(message)}", status_code=303)
