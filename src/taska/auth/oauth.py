import hashlib
import hmac
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import Request
from fastapi.responses import RedirectResponse

from taska.auth.dependencies import COOKIE_NAME
from taska.auth.security import create_access_token
from taska.config import get_settings

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
OAUTH_STATE_COOKIE = "taska_oauth_state"
LINK_USER_COOKIE = "taska_oauth_link_user"


def github_configured() -> bool:
    settings = get_settings()
    return bool(settings.github_client_id and settings.github_client_secret)


def telegram_configured() -> bool:
    settings = get_settings()
    return bool(settings.telegram_bot_token and settings.telegram_bot_username)


def start_github_oauth(*, link_username: str | None = None) -> RedirectResponse:
    settings = get_settings()
    if not github_configured():
        return RedirectResponse("/login?error=GitHub+OAuth+не+настроен", status_code=303)

    state = secrets.token_urlsafe(32)
    params = {
        "client_id": settings.github_client_id,
        "redirect_uri": f"{settings.base_url.rstrip('/')}/auth/github/callback",
        "scope": "read:user user:email",
        "state": state,
    }
    response = RedirectResponse(f"{GITHUB_AUTHORIZE_URL}?{urlencode(params)}", status_code=303)
    response.set_cookie(OAUTH_STATE_COOKIE, state, httponly=True, samesite="lax", max_age=600)
    if link_username:
        response.set_cookie(LINK_USER_COOKIE, link_username, httponly=True, samesite="lax", max_age=600)
    return response


async def exchange_github_code(code: str) -> dict:
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        token_response = await client.post(
            GITHUB_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.github_client_id,
                "client_secret": settings.github_client_secret,
                "code": code,
            },
        )
        token_response.raise_for_status()
        access_token = token_response.json().get("access_token")
        if not access_token:
            msg = "Не удалось получить токен GitHub"
            raise ValueError(msg)

        user_response = await client.get(
            GITHUB_USER_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        user_response.raise_for_status()
        return user_response.json()


def verify_telegram_auth(data: dict[str, str]) -> bool:
    settings = get_settings()
    if not settings.telegram_bot_token:
        return False

    received_hash = data.get("hash")
    if not received_hash:
        return False

    check_items = {k: v for k, v in data.items() if k != "hash" and v}
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(check_items.items()))
    secret_key = hashlib.sha256(settings.telegram_bot_token.encode()).digest()
    calculated = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(calculated, received_hash)


def login_response(user, *, redirect_to: str = "/") -> RedirectResponse:
    token = create_access_token(user.username, is_admin=user.is_admin)
    response = RedirectResponse(redirect_to, status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24,
    )
    return response


def clear_oauth_cookies(response: RedirectResponse) -> RedirectResponse:
    response.delete_cookie(OAUTH_STATE_COOKIE)
    response.delete_cookie(LINK_USER_COOKIE)
    return response


def validate_oauth_state(request: Request, state: str | None) -> bool:
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE)
    return bool(state and cookie_state and secrets.compare_digest(state, cookie_state))
