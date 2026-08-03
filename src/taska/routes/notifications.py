from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.user import User
from taska.services.bootstrap import get_site_context
from taska.services.notifications import list_notifications, mark_all_read, unread_count

router = APIRouter(prefix="/notifications", tags=["notifications"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


@router.get("", response_class=HTMLResponse)
def notifications_page(
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user is None:
        return RedirectResponse("/login", status_code=303)
    notifications = list_notifications(db, user.id)
    mark_all_read(db, user.id)
    return templates.TemplateResponse(
        request,
        "notifications/list.html",
        {"user": user, "site": get_site_context(db), "notifications": notifications},
    )


@router.get("/unread-count")
def notifications_unread_count(
    user: User | None = Depends(get_current_user), db: Session = Depends(get_db)
):
    return {"count": unread_count(db, user.id) if user else 0}
