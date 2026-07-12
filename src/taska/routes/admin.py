from pathlib import Path

from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_admin_stats, get_site_context
from taska.services.invitation import create_invitation, list_invitations
from taska.services.token_generator import POSITION_CODES, build_member_token, parse_member_token

router = APIRouter(prefix="/admin", tags=["admin"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _require_admin(user: User | None) -> User | RedirectResponse:
    if user is None or not user.is_admin:
        return RedirectResponse("/login", status_code=303)
    return user


@router.get("", response_class=HTMLResponse)
def admin_dashboard(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    stats = get_admin_stats(db)
    site = get_site_context(db)
    return templates.TemplateResponse(
        request,
        "admin/dashboard.html",
        {"user": admin, "stats": stats, "site": site},
    )


@router.get("/invitations", response_class=HTMLResponse)
def invitations_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    created: str | None = None,
):
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    site = get_site_context(db)
    invitations = list_invitations(db)
    invite_links = [
        {
            "invitation": inv,
            "url": f"{site['base_url']}/invite/{inv.token}",
        }
        for inv in invitations
    ]

    return templates.TemplateResponse(
        request,
        "admin/invitations.html",
        {
            "user": admin,
            "invitations": invite_links,
            "created": created,
            "site": site,
        },
    )


@router.post("/invitations")
def create_invitation_link(
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    invitation = create_invitation(db, admin)
    return RedirectResponse(f"/admin/invitations?created={invitation.token}", status_code=303)


@router.get("/tokens", response_class=HTMLResponse)
def tokens_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
    generated: str | None = None,
    error: str | None = None,
):
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    site = get_site_context(db)
    parsed = None
    token_value = unquote(generated) if generated else None
    if token_value:
        try:
            parsed = parse_member_token(token_value)
        except ValueError:
            parsed = None

    return templates.TemplateResponse(
        request,
        "admin/tokens.html",
        {
            "user": admin,
            "positions": POSITION_CODES,
            "generated": token_value,
            "parsed": parsed,
            "error": unquote(error) if error else None,
            "site": site,
        },
    )


@router.post("/tokens")
def generate_token(
    user: User | None = Depends(get_current_user),
    position_code: str = Form(...),
    experience_years: int = Form(...),
    full_name: str = Form(...),
) -> RedirectResponse:
    admin = _require_admin(user)
    if isinstance(admin, RedirectResponse):
        return admin

    try:
        token = build_member_token(
            position_code=position_code,
            experience_years=experience_years,
            full_name=full_name,
        )
    except ValueError as exc:
        return RedirectResponse(f"/admin/tokens?error={quote(str(exc))}", status_code=303)

    return RedirectResponse(f"/admin/tokens?generated={quote(token)}", status_code=303)
