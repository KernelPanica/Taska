from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from taska.auth.dependencies import get_current_user
from taska.auth.oauth import github_configured, start_github_oauth, telegram_configured
from taska.auth.security import hash_password, verify_password
from taska.config import get_settings
from taska.database import get_db
from taska.models.user import User
from taska.services.account import unlink_github, unlink_telegram, update_user_profile
from taska.services.bootstrap import get_site_context
from taska.services.profiles import get_position_label

router = APIRouter(tags=["account"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _require_login(user: User | None) -> User | RedirectResponse:
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return user


@router.get("/account", response_class=HTMLResponse)
def account_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    success: str | None = None,
    error: str | None = None,
):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    profile = db.scalar(
        select(User).where(User.id == current.id).options(selectinload(User.tags))
    )
    site = get_site_context(db)
    settings = get_settings()

    return templates.TemplateResponse(
        request,
        "account/profile.html",
        {
            "user": profile,
            "site": site,
            "position_label": get_position_label(profile.position_code),
            "github_configured": github_configured(),
            "telegram_configured": telegram_configured(),
            "telegram_bot_username": settings.telegram_bot_username,
            "success": unquote(success) if success else None,
            "error": unquote(error) if error else None,
        },
    )


@router.post("/account")
def account_update(
    display_name: str = Form(...),
    bio: str = Form(""),
    current_password: str = Form(""),
    new_password: str = Form(""),
    new_password_confirm: str = Form(""),
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    try:
        update_user_profile(db, current, display_name=display_name, bio=bio)
    except ValueError as exc:
        return RedirectResponse(f"/account?error={quote(str(exc))}", status_code=303)

    if new_password:
        if not verify_password(current_password, current.password_hash):
            return RedirectResponse(
                f"/account?error={quote('Неверный текущий пароль')}",
                status_code=303,
            )
        if new_password != new_password_confirm:
            return RedirectResponse(
                f"/account?error={quote('Новые пароли не совпадают')}",
                status_code=303,
            )
        if len(new_password) < 8:
            return RedirectResponse(
                f"/account?error={quote('Пароль должен быть не короче 8 символов')}",
                status_code=303,
            )
        current.password_hash = hash_password(new_password)
        db.commit()

    return RedirectResponse(f"/account?success={quote('Профиль обновлён')}", status_code=303)


@router.get("/account/link/github")
def account_link_github(user: User | None = Depends(get_current_user)):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    return start_github_oauth(link_username=current.username)


@router.get("/account/link/telegram")
def account_link_telegram(user: User | None = Depends(get_current_user)):
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current
    response = RedirectResponse("/account", status_code=303)
    from taska.auth.oauth import LINK_USER_COOKIE

    response.set_cookie(LINK_USER_COOKIE, current.username, httponly=True, samesite="lax", max_age=600)
    return response


@router.post("/account/unlink/github")
def account_unlink_github(
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    unlink_github(db, current)
    return RedirectResponse(f"/account?success={quote('GitHub отвязан')}", status_code=303)


@router.post("/account/unlink/telegram")
def account_unlink_telegram(
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    current = _require_login(user)
    if isinstance(current, RedirectResponse):
        return current

    unlink_telegram(db, current)
    return RedirectResponse(f"/account?success={quote('Telegram отвязан')}", status_code=303)
