from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.auth.oauth import (
    LINK_USER_COOKIE,
    clear_oauth_cookies,
    exchange_github_code,
    login_response,
    start_github_oauth,
    validate_oauth_state,
    verify_telegram_auth,
)
from taska.auth.security import decode_oauth_link_token
from taska.database import get_db
from taska.models.user import User
from taska.services.account import (
    find_user_by_github,
    find_user_by_telegram,
    link_github,
    link_telegram,
)

router = APIRouter(prefix="/auth", tags=["oauth"])


@router.get("/github")
def github_login(user: User | None = Depends(get_current_user)):
    link_username = user.username if user else None
    return start_github_oauth(link_username=link_username)


@router.get("/github/callback")
async def github_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    db: Session = Depends(get_db),
):
    if not code or not validate_oauth_state(request, state):
        response = RedirectResponse("/login?error=Ошибка+авторизации+GitHub", status_code=303)
        return clear_oauth_cookies(response)

    try:
        github_user = await exchange_github_code(code)
    except Exception:
        response = RedirectResponse(
            "/login?error=Не+удалось+авторизоваться+через+GitHub", status_code=303
        )
        return clear_oauth_cookies(response)

    github_id = int(github_user["id"])
    github_username = github_user.get("login", "")

    link_username = decode_oauth_link_token(request.cookies.get(LINK_USER_COOKIE, ""))
    if link_username:
        user = db.scalar(select(User).where(User.username == link_username))
        if user is None:
            response = RedirectResponse("/login?error=Сессия+привязки+истекла", status_code=303)
            return clear_oauth_cookies(response)
        try:
            link_github(db, user, github_id=github_id, github_username=github_username)
        except ValueError as exc:
            response = RedirectResponse(f"/account?error={quote(str(exc))}", status_code=303)
            return clear_oauth_cookies(response)
        response = RedirectResponse("/account?success=GitHub+привязан", status_code=303)
        return clear_oauth_cookies(response)

    user = find_user_by_github(db, github_id)
    if user is None:
        response = RedirectResponse(
            "/login?error=GitHub+не+привязан.+Войдите+по+паролю+и+привяжите+в+профиле",
            status_code=303,
        )
        return clear_oauth_cookies(response)

    response = login_response(user)
    return clear_oauth_cookies(response)


@router.post("/telegram/callback")
async def telegram_callback(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    data = {k: str(v) for k, v in form.items()}

    if not verify_telegram_auth(dict(data)):
        return RedirectResponse("/login?error=Неверные+данные+Telegram", status_code=303)

    telegram_id = int(data["id"])
    telegram_username = data.get("username") or None

    link_username = decode_oauth_link_token(request.cookies.get(LINK_USER_COOKIE, ""))
    if link_username:
        user = db.scalar(select(User).where(User.username == link_username))
        if user is None:
            return RedirectResponse("/account?error=Сессия+привязки+истекла", status_code=303)
        try:
            link_telegram(db, user, telegram_id=telegram_id, telegram_username=telegram_username)
        except ValueError as exc:
            return RedirectResponse(f"/account?error={quote(str(exc))}", status_code=303)
        response = RedirectResponse("/account?success=Telegram+привязан", status_code=303)
        response.delete_cookie(LINK_USER_COOKIE)
        return response

    user = find_user_by_telegram(db, telegram_id)
    if user is None:
        return RedirectResponse(
            "/login?error=Telegram+не+привязан.+Войдите+по+паролю+и+привяжите+в+профиле",
            status_code=303,
        )

    return login_response(user)
