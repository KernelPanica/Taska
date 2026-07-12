from pathlib import Path

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import COOKIE_NAME, get_current_user
from taska.auth.oauth import github_configured, telegram_configured
from taska.auth.security import create_access_token, verify_password
from taska.config import get_settings
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.setup import is_setup_required

router = APIRouter(tags=["auth"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


@router.get("/login", response_class=HTMLResponse)
def login_page(
    request: Request,
    db: Session = Depends(get_db),
    error: str | None = None,
):
    if is_setup_required(db):
        return RedirectResponse("/setup", status_code=303)

    site = get_site_context(db)
    settings = get_settings()
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "error": error,
            "site": site,
            "user": None,
            "github_configured": github_configured(),
            "telegram_configured": telegram_configured(),
            "telegram_bot_username": settings.telegram_bot_username,
        },
    )


@router.post("/login")
def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    user = db.scalar(select(User).where(User.username == username))
    if user is None or not verify_password(password, user.password_hash):
        return RedirectResponse("/login?error=Неверный+логин+или+пароль", status_code=303)

    token = create_access_token(user.username, is_admin=user.is_admin)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24,
    )
    return response


@router.post("/logout")
def logout() -> RedirectResponse:
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(COOKIE_NAME)
    return response

