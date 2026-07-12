from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.auth.oauth import github_configured, telegram_configured
from taska.config import get_settings
from taska.constants import TASK_STATUSES
from taska.database import get_db
from taska.models.user import User
from taska.services.account import get_user_dashboard
from taska.services.bootstrap import get_admin_stats, get_site_context
from taska.services.projects import is_pm

router = APIRouter(tags=["dashboard"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


@router.get("/", response_class=HTMLResponse)
def home(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    site = get_site_context(db)

    if user is None:
        return templates.TemplateResponse(
            request,
            "home.html",
            {"user": None, "site": site},
        )

    if user.is_admin:
        admin_stats = get_admin_stats(db)
        return templates.TemplateResponse(
            request,
            "dashboard/admin.html",
            {"user": user, "site": site, "stats": admin_stats},
        )

    dashboard = get_user_dashboard(db, user)
    return templates.TemplateResponse(
        request,
        "dashboard/member.html",
        {
            "user": user,
            "site": site,
            "dashboard": dashboard,
            "statuses": TASK_STATUSES,
            "is_pm": is_pm(user),
        },
    )
