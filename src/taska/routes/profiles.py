from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.profiles import (
    approve_tag_suggestion,
    assign_tag_to_user,
    get_member_profile,
    get_position_label,
    list_all_tags,
    list_member_profiles,
    pending_suggestions_for_user,
    reject_tag_suggestion,
    remove_tag_from_user,
    suggest_tag,
)

router = APIRouter(tags=["profiles"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _require_login(user: User | None) -> User | RedirectResponse:
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return user


@router.get("/profiles", response_class=HTMLResponse)
def profiles_list(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    members = list_member_profiles(db)
    site = get_site_context(db)
    profiles = [
        {
            "user": member,
            "position_label": get_position_label(member.position_code),
        }
        for member in members
    ]

    return templates.TemplateResponse(
        request,
        "profiles/list.html",
        {"user": current, "profiles": profiles, "site": site},
    )


@router.get("/profiles/{username}", response_class=HTMLResponse)
def profile_detail(
    request: Request,
    username: str,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    success: str | None = None,
    error: str | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    profile = get_member_profile(db, username)
    if profile is None:
        return RedirectResponse("/profiles", status_code=303)

    site = get_site_context(db)
    is_own_profile = current.id == profile.id
    is_admin = current.is_admin
    pending = pending_suggestions_for_user(db, profile.id) if is_admin else []

    return templates.TemplateResponse(
        request,
        "profiles/detail.html",
        {
            "user": current,
            "profile": profile,
            "position_label": get_position_label(profile.position_code),
            "site": site,
            "is_own_profile": is_own_profile,
            "is_admin": is_admin,
            "all_tags": list_all_tags(db) if is_admin else [],
            "pending_suggestions": pending,
            "success": unquote(success) if success else None,
            "error": unquote(error) if error else None,
        },
    )


@router.post("/profiles/{username}/suggest-tag")
def suggest_profile_tag(
    username: str,
    tag_name: str = Form(...),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    if current.username != username:
        return RedirectResponse(
            f"/profiles/{username}?error={quote('Можно предлагать теги только своему профилю')}",
            status_code=303,
        )

    try:
        suggest_tag(db, current, tag_name)
    except ValueError as exc:
        return RedirectResponse(
            f"/profiles/{username}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/profiles/{username}?success={quote('Тег отправлен на рассмотрение администратору')}",
        status_code=303,
    )


@router.post("/profiles/{username}/tags")
def admin_assign_tag(
    username: str,
    tag_name: str = Form(...),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    if not current.is_admin:
        return RedirectResponse(f"/profiles/{username}", status_code=303)

    profile = get_member_profile(db, username)
    if profile is None:
        return RedirectResponse("/profiles", status_code=303)

    try:
        assign_tag_to_user(db, profile, tag_name, current)
    except ValueError as exc:
        return RedirectResponse(
            f"/profiles/{username}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/profiles/{username}?success={quote('Тег назначен')}",
        status_code=303,
    )


@router.post("/profiles/{username}/tags/{tag_id}/remove")
def admin_remove_tag(
    username: str,
    tag_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    if not current.is_admin:
        return RedirectResponse(f"/profiles/{username}", status_code=303)

    profile = get_member_profile(db, username)
    if profile is None:
        return RedirectResponse("/profiles", status_code=303)

    remove_tag_from_user(db, profile, tag_id)
    return RedirectResponse(
        f"/profiles/{username}?success={quote('Тег удалён')}",
        status_code=303,
    )


@router.post("/profiles/{username}/suggestions/{suggestion_id}/approve")
def admin_approve_suggestion(
    username: str,
    suggestion_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    if not current.is_admin:
        return RedirectResponse(f"/profiles/{username}", status_code=303)

    try:
        approve_tag_suggestion(db, suggestion_id, current)
    except ValueError as exc:
        return RedirectResponse(
            f"/profiles/{username}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/profiles/{username}?success={quote('Предложение одобрено, тег назначен')}",
        status_code=303,
    )


@router.post("/profiles/{username}/suggestions/{suggestion_id}/reject")
def admin_reject_suggestion(
    username: str,
    suggestion_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    if not current.is_admin:
        return RedirectResponse(f"/profiles/{username}", status_code=303)

    try:
        reject_tag_suggestion(db, suggestion_id, current)
    except ValueError as exc:
        return RedirectResponse(
            f"/profiles/{username}?error={quote(str(exc))}",
            status_code=303,
        )

    return RedirectResponse(
        f"/profiles/{username}?success={quote('Предложение отклонено')}",
        status_code=303,
    )
