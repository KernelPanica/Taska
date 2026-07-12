from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import COOKIE_NAME
from taska.auth.security import create_access_token
from taska.config import get_settings
from taska.database import get_db
from taska.services.setup import complete_initial_setup, is_setup_required

router = APIRouter(tags=["setup"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


@router.get("/setup", response_class=HTMLResponse)
def setup_page(
    request: Request,
    db: Session = Depends(get_db),
    error: str | None = None,
):
    if not is_setup_required(db):
        return RedirectResponse("/login", status_code=303)

    settings = get_settings()
    return templates.TemplateResponse(
        request,
        "setup.html",
        {
            "error": unquote(error) if error else None,
            "defaults": settings,
        },
    )


@router.post("/setup")
def setup_submit(
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

    if admin_password != admin_password_confirm:
        return RedirectResponse(
            f"/setup?error={quote('Пароли не совпадают')}",
            status_code=303,
        )

    if len(admin_password) < 8:
        return RedirectResponse(
            f"/setup?error={quote('Пароль должен быть не короче 8 символов')}",
            status_code=303,
        )

    try:
        admin = complete_initial_setup(
            db,
            organization_name=organization_name,
            app_name=app_name,
            base_url=base_url,
            admin_username=admin_username,
            admin_password=admin_password,
        )
    except ValueError as exc:
        return RedirectResponse(f"/setup?error={quote(str(exc))}", status_code=303)

    token = create_access_token(admin.username, is_admin=True)
    response = RedirectResponse("/admin", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24,
    )
    return response
