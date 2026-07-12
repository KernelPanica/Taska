from pathlib import Path

from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import COOKIE_NAME
from taska.auth.security import create_access_token
from taska.database import get_db
from taska.models.user import User
from taska.services.invitation import get_valid_invitation, register_via_invitation
from taska.services.token_generator import parse_member_token

router = APIRouter(tags=["invite"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


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
            "error": unquote(error) if error else None,
            "user": None,
        },
    )


@router.post("/invite/{token}")
def invite_register(
    token: str,
    username: str = Form(...),
    password: str = Form(...),
    member_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    invitation = get_valid_invitation(db, token)
    if invitation is None:
        return RedirectResponse("/login?error=Приглашение+недействительно", status_code=303)

    existing = db.scalar(select(User).where(User.username == username))
    if existing is not None:
        return RedirectResponse(
            f"/invite/{token}?error={quote('Имя пользователя уже занято')}",
            status_code=303,
        )

    try:
        parse_member_token(member_token)
    except ValueError as exc:
        return RedirectResponse(f"/invite/{token}?error={quote(str(exc))}", status_code=303)

    user = register_via_invitation(
        db,
        invitation,
        username=username.strip(),
        password=password,
        member_token=member_token.strip(),
    )

    session_token = create_access_token(user.username, is_admin=False)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24,
    )
    return response
