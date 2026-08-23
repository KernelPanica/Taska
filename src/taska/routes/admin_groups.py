from pathlib import Path
from urllib.parse import quote
from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.knowledge import AccessGroup
from taska.models.user import User
from taska.models.role import CustomRole, DisabledSystemRole
from taska.roles import POSITION_CODES
from taska.services.bootstrap import get_site_context

router = APIRouter(prefix="/admin", tags=["admin-groups"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))

def admin(user):
    return user if user and user.is_admin else None

@router.get("/groups", response_class=HTMLResponse)
def groups_page(request: Request, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    roles = list(db.scalars(select(CustomRole).order_by(CustomRole.name)).all())
    disabled = set(db.scalars(select(DisabledSystemRole.code)).all())
    system_roles = {code: name for code, name in POSITION_CODES.items() if code not in disabled}
    return templates.TemplateResponse(request, "admin/groups.html", {"user": user, "site": get_site_context(db), "groups": list(db.scalars(select(AccessGroup).options(selectinload(AccessGroup.members)).order_by(AccessGroup.name)).all()), "users": list(db.scalars(select(User).order_by(User.username)).all()), "roles": roles, "system_roles": system_roles, "error": request.query_params.get("error")})

@router.post("/roles/system/{role_code}/delete")
def delete_system_role(role_code: str, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    if role_code in POSITION_CODES and not db.scalar(select(User).where(User.position_code == role_code).limit(1)):
        db.merge(DisabledSystemRole(code=role_code)); db.commit()
    return RedirectResponse("/admin/groups#roles", status_code=303)

@router.post("/roles/{role_id}/delete")
def delete_role(role_id: int, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    role = db.get(CustomRole, role_id)
    if role and not db.scalar(select(User).where(User.position_code == role.code).limit(1)):
        db.delete(role); db.commit()
    return RedirectResponse("/admin/groups#roles", status_code=303)

@router.post("/groups")
def create_group(name: str = Form(...), description: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    clean_name = " ".join(name.split())
    if clean_name and not db.scalar(select(AccessGroup).where(AccessGroup.name == clean_name)):
        db.add(AccessGroup(name=clean_name, description=description.strip())); db.commit()
    return RedirectResponse("/admin/groups#groups", status_code=303)

@router.post("/groups/{group_id}")
def update_group(group_id: int, name: str = Form(...), description: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    group = db.get(AccessGroup, group_id)
    if group: group.name, group.description = " ".join(name.split()), description.strip(); db.commit()
    return RedirectResponse("/admin/groups", status_code=303)

@router.post("/groups/{group_id}/delete")
def delete_group(group_id: int, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    group = db.get(AccessGroup, group_id)
    if group:
        db.delete(group); db.commit()
    return RedirectResponse("/admin/groups", status_code=303)

@router.post("/groups/{group_id}/members")
def add_member(group_id: int, user_id: int = Form(...), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    group, member = db.get(AccessGroup, group_id), db.get(User, user_id)
    if group and member and member not in group.members: group.members.append(member); db.commit()
    return RedirectResponse("/admin/groups", status_code=303)

@router.post("/groups/{group_id}/members/{user_id}/delete")
def remove_member(group_id: int, user_id: int, user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if not admin(user): return RedirectResponse("/login", status_code=303)
    group, member = db.get(AccessGroup, group_id), db.get(User, user_id)
    if group and member and member in group.members:
        group.members.remove(member)
        db.commit()
    return RedirectResponse("/admin/groups#groups", status_code=303)
