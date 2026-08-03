from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
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
        # Keep the template compatible with existing databases and mocked stats.
        admin_stats.setdefault(
            "task_status_counts", {status: 0 for status in TASK_STATUSES}
        )
        for status in TASK_STATUSES:
            admin_stats["task_status_counts"].setdefault(status, 0)
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
            "task_status_counts": dashboard.get("status_counts", {}),
        },
    )
