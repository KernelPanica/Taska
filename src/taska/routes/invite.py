from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import COOKIE_NAME
from taska.auth.oauth import discord_configured, start_discord_oauth
from taska.auth.security import create_access_token, create_invitation_oauth_token
from taska.database import get_db
from taska.models.user import User
from taska.services.invitation import get_valid_invitation, register_via_invitation

router = APIRouter(tags=["invite"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))
INVITATION_OAUTH_COOKIE = "taska_invitation_oauth"


@router.get("/invite/{token}", response_class=HTMLResponse)
def invite_page(
    request: Request,
    token: str,
    db: Session = Depends(get_db),
    error: str | None = None,
) -> HTMLResponse:
    invitation = get_valid_invitation(db, token)
    return templates.TemplateResponse(
        request,
        "invite.html",
        {
            "invitation": invitation,
            "token": token,
            "discord_configured": discord_configured(),
            "error": unquote(error) if error else None,
            "user": None,
        },
    )


@router.post("/invite/{token}")
def invite_register(
    token: str,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    invitation = get_valid_invitation(db, token)
    if invitation is None:
        return RedirectResponse("/login?error=Приглашение+недействительно", status_code=303)
    username = username.strip()
    if not username or db.scalar(select(User).where(User.username == username)) is not None:
        return RedirectResponse(
            f"/invite/{token}?error={quote('Имя пользователя уже занято')}", status_code=303
        )
    if len(password) < 8:
        return RedirectResponse(
            f"/invite/{token}?error={quote('Пароль должен быть не короче 8 символов')}",
            status_code=303,
        )
    user = register_via_invitation(db, invitation, username=username, password=password)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        COOKIE_NAME,
        create_access_token(user.username, is_admin=False),
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24,
    )
    return response


@router.get("/invite/{token}/discord")
def invite_register_discord(token: str, db: Session = Depends(get_db)) -> RedirectResponse:
    if get_valid_invitation(db, token) is None:
        return RedirectResponse("/login?error=Приглашение+недействительно", status_code=303)
    response = start_discord_oauth()
    response.set_cookie(
        INVITATION_OAUTH_COOKIE,
        create_invitation_oauth_token(token),
        httponly=True,
        samesite="lax",
        max_age=600,
    )
    return response
