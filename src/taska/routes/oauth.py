from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.auth.oauth import (
    LINK_USER_COOKIE,
    clear_oauth_cookies,
    exchange_discord_code,
    exchange_github_code,
    login_response,
    start_discord_oauth,
    start_github_oauth,
    validate_oauth_state,
    verify_telegram_auth,
)
from taska.auth.security import decode_invitation_oauth_token, decode_oauth_link_token
from taska.database import get_db
from taska.models.user import User
from taska.services.account import (
    find_user_by_discord,
    find_user_by_github,
    find_user_by_telegram,
    link_discord,
    link_github,
    link_telegram,
)
from taska.services.invitation import get_valid_invitation, register_discord_via_invitation

router = APIRouter(prefix="/auth", tags=["oauth"])
INVITATION_OAUTH_COOKIE = "taska_invitation_oauth"


@router.get("/discord")
def discord_login(user: User | None = Depends(get_current_user)):
    return start_discord_oauth(link_username=user.username if user else None)


@router.get("/discord/callback")
async def discord_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    db: Session = Depends(get_db),
):
    if not code or not validate_oauth_state(request, state):
        return clear_oauth_cookies(
            RedirectResponse("/login?error=Ошибка+авторизации+Discord", status_code=303)
        )
    try:
        discord_user = await exchange_discord_code(code)
    except Exception:
        return clear_oauth_cookies(
            RedirectResponse("/login?error=Не+удалось+войти+через+Discord", status_code=303)
        )

    discord_id = int(discord_user["id"])
    discord_username = discord_user.get("global_name") or discord_user.get("username", "")
    avatar_hash = discord_user.get("avatar")
    avatar_url = (
        f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png?size=256"
        if avatar_hash
        else None
    )
    link_username = decode_oauth_link_token(request.cookies.get(LINK_USER_COOKIE, ""))
    if link_username:
        user = db.scalar(select(User).where(User.username == link_username))
        if user is None:
            return clear_oauth_cookies(
                RedirectResponse("/login?error=Сессия+привязки+истекла", status_code=303)
            )
        try:
            link_discord(
                db,
                user,
                discord_id=discord_id,
                discord_username=discord_username,
                discord_avatar_url=avatar_url,
            )
        except ValueError as exc:
            return clear_oauth_cookies(
                RedirectResponse(f"/account?error={quote(str(exc))}", status_code=303)
            )
        return clear_oauth_cookies(
            RedirectResponse("/account?success=Discord+привязан", status_code=303)
        )

    invitation_token = decode_invitation_oauth_token(
        request.cookies.get(INVITATION_OAUTH_COOKIE, "")
    )
    if invitation_token:
        invitation = get_valid_invitation(db, invitation_token)
        if invitation is None:
            return clear_oauth_cookies(
                RedirectResponse("/login?error=Приглашение+недействительно", status_code=303)
            )
        if find_user_by_discord(db, discord_id) is not None:
            return clear_oauth_cookies(
                RedirectResponse("/login?error=Discord+уже+привязан", status_code=303)
            )
        username = discord_username.lower().replace(" ", "-")[:48] or f"discord-{discord_id}"
        if db.scalar(select(User).where(User.username == username)) is not None:
            username = f"{username}-{str(discord_id)[-6:]}"
        user = register_discord_via_invitation(
            db,
            invitation,
            username=username,
            discord_id=discord_id,
            discord_username=discord_username,
            discord_avatar_url=avatar_url,
        )
        response = login_response(user)
        response.delete_cookie(INVITATION_OAUTH_COOKIE)
        return clear_oauth_cookies(response)

    user = find_user_by_discord(db, discord_id)
    if user is None:
        return clear_oauth_cookies(
            RedirectResponse(
                "/login?error=Discord+не+привязан.+Зарегистрируйтесь+по+приглашению+и+привяжите+его+в+профиле",
                status_code=303,
            )
        )
    return clear_oauth_cookies(login_response(user))


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


@router.api_route("/telegram/callback", methods=["GET", "POST"])
async def telegram_callback(request: Request, db: Session = Depends(get_db)):
    if request.method == "POST":
        form = await request.form()
        data = {k: str(v) for k, v in form.items()}
    else:
        data = dict(request.query_params)

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
