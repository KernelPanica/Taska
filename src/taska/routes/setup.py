import hmac
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.security import create_setup_unlock_token, verify_setup_unlock_token
from taska.config import get_settings
from taska.database import get_db
from taska.services.setup import complete_initial_setup, is_setup_required

router = APIRouter(tags=["setup"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))
SETUP_UNLOCK_COOKIE = "taska_setup_unlocked"


def _setup_is_unlocked(request: Request) -> bool:
    return verify_setup_unlock_token(request.cookies.get(SETUP_UNLOCK_COOKIE, ""))


@router.get("/setup", response_class=HTMLResponse)
def setup_page(
    request: Request,
    db: Session = Depends(get_db),
    error: str | None = None,
):
    if not is_setup_required(db):
        return RedirectResponse("/login", status_code=303)

    if not _setup_is_unlocked(request):
        return templates.TemplateResponse(
            request,
            "setup_unlock.html",
            {"error": unquote(error) if error else None},
        )

    return templates.TemplateResponse(
        request,
        "setup.html",
        {
            "error": unquote(error) if error else None,
            "defaults": get_settings(),
        },
    )


@router.post("/setup/unlock")
def setup_unlock(
    request: Request,
    setup_key: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if not is_setup_required(db):
        return RedirectResponse("/login", status_code=303)

    configured_key = get_settings().setup_key.strip()
    if len(configured_key) < 32 or not hmac.compare_digest(setup_key, configured_key):
        return RedirectResponse(
            f"/setup?error={quote('Неверный ключ первоначальной настройки')}",
            status_code=303,
        )

    response = RedirectResponse("/setup", status_code=303)
    response.set_cookie(
        SETUP_UNLOCK_COOKIE,
        create_setup_unlock_token(),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=15 * 60,
    )
    return response


@router.post("/setup")
def setup_submit(
    request: Request,
    organization_name: str = Form(...),
    app_name: str = Form(""),
    base_url: str = Form(""),
    admin_username: str = Form(...),
    admin_password: str = Form(...),
    admin_password_confirm: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if not is_setup_required(db):
        return RedirectResponse("/login", status_code=303)
    if not _setup_is_unlocked(request):
        return RedirectResponse("/setup", status_code=303)

    if admin_password != admin_password_confirm:
        return RedirectResponse(
            f"/setup?error={quote('Пароли не совпадают')}", status_code=303
        )
    if len(admin_password) < 8:
        return RedirectResponse(
            f"/setup?error={quote('Пароль должен быть не короче 8 символов')}",
            status_code=303,
        )

    try:
        complete_initial_setup(
            db,
            organization_name=organization_name,
            app_name=app_name,
            base_url=base_url,
            admin_username=admin_username,
            admin_password=admin_password,
        )
    except ValueError as exc:
        return RedirectResponse(f"/setup?error={quote(str(exc))}", status_code=303)

    response = RedirectResponse(
        f"/login?success={quote('Настройка завершена. Войдите как администратор')}",
        status_code=303,
    )
    response.delete_cookie(SETUP_UNLOCK_COOKIE)
    return response
