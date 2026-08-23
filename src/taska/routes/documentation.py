from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from taska.auth.dependencies import get_current_user
from taska.database import get_db
from taska.models.knowledge import AccessGroup, DocumentNode, DocumentPermission, StorageConnection
from taska.models.user import User
from taska.services.bootstrap import get_site_context

router = APIRouter(tags=["documentation"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))
PROVIDERS = {"onedrive": "OneDrive", "google_drive": "Google Disk", "github": "GitHub", "local": "Локальное хранилище", "external": "Удалённое хранилище"}


def allowed_nodes(db: Session, user: User) -> list[DocumentNode]:
    nodes = list(db.scalars(select(DocumentNode).options(selectinload(DocumentNode.permissions).selectinload(DocumentPermission.group)).order_by(DocumentNode.path)).all())
    if user.is_admin:
        return nodes
    group_ids = {group.id for group in user.access_groups}
    return [node for node in nodes if not node.permissions or any(p.group_id in group_ids for p in node.permissions)]


@router.get("/docs", response_class=HTMLResponse)
def documentation_page(request: Request, user: User | None = Depends(get_current_user), db: Session = Depends(get_db), success: str | None = None, error: str | None = None, tab: str = "documents", node: int | None = None):
    if user is None:
        return RedirectResponse("/login", status_code=303)
    visible_nodes = allowed_nodes(db, user)
    selected_node = next((item for item in visible_nodes if item.id == node), None)
    return templates.TemplateResponse(request, "documentation/index.html", {
        "user": user, "site": get_site_context(db), "nodes": visible_nodes,
        "storages": list(db.scalars(select(StorageConnection).order_by(StorageConnection.name)).all()),
        "groups": list(db.scalars(select(AccessGroup).options(selectinload(AccessGroup.members)).order_by(AccessGroup.name)).all()),
        "users": list(db.scalars(select(User).order_by(User.username)).all()), "providers": PROVIDERS,
        "success": unquote(success) if success else None, "error": unquote(error) if error else None, "tab": tab,
        "selected_node": selected_node,
    })


@router.post("/docs/groups")
def create_group(name: str = Form(...), description: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None or not user.is_admin: return RedirectResponse("/login", status_code=303)
    clean = " ".join(name.split())
    if len(clean) < 2 or db.scalar(select(AccessGroup).where(AccessGroup.name == clean)):
        return RedirectResponse(f"/docs?error={quote('Некорректное или занятое название группы')}", status_code=303)
    db.add(AccessGroup(name=clean, description=description.strip())); db.commit()
    return RedirectResponse("/docs?success=Группа создана", status_code=303)


@router.post("/docs/groups/{group_id}/members")
def add_group_member(group_id: int, user_id: int = Form(...), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None or not user.is_admin: return RedirectResponse("/login", status_code=303)
    group, member = db.get(AccessGroup, group_id), db.get(User, user_id)
    if group and member and member not in group.members: group.members.append(member); db.commit()
    return RedirectResponse("/docs?success=Состав группы обновлён", status_code=303)


@router.post("/docs/groups/{group_id}")
def edit_group(group_id: int, name: str = Form(...), description: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None or not user.is_admin: return RedirectResponse("/login", status_code=303)
    group = db.get(AccessGroup, group_id)
    clean = " ".join(name.split())
    duplicate = db.scalar(select(AccessGroup).where(AccessGroup.name == clean, AccessGroup.id != group_id))
    if group is None or len(clean) < 2 or duplicate:
        return RedirectResponse(f"/docs?error={quote('Некорректное название группы')}", status_code=303)
    group.name, group.description = clean, description.strip(); db.commit()
    return RedirectResponse("/docs?success=Группа обновлена", status_code=303)


@router.post("/docs/storages")
def create_storage(name: str = Form(...), provider: str = Form(...), root_path: str = Form("/"), endpoint: str = Form(""), repository: str = Form(""), host: str = Form(""), username: str = Form(""), password: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None or not user.is_admin: return RedirectResponse("/docs", status_code=303)
    if provider not in PROVIDERS: return RedirectResponse("/docs?error=Неизвестный провайдер", status_code=303)
    root = "/" + "/".join(part for part in root_path.strip().split("/") if part) if root_path.strip() else "/"
    if db.scalar(select(StorageConnection.id).limit(1)) is not None:
        return RedirectResponse("/docs?error=Первоначальная настройка уже выполнена", status_code=303)
    storage = StorageConnection(name=name.strip()[:128], provider=provider, root_path=root, endpoint=endpoint.strip(), repository=repository.strip(), host=host.strip(), username=username.strip(), password=password, created_by_id=user.id)
    db.add(storage); db.flush(); db.add(DocumentNode(storage_id=storage.id, name=storage.name, path=storage.root_path, is_folder=True)); db.commit()
    return RedirectResponse("/docs?tab=documents&success=Хранилище подключено", status_code=303)


@router.post("/docs/nodes")
def create_node(storage_id: int = Form(...), name: str = Form(...), path: str = Form(...), node_type: str = Form("file"), external_url: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None: return RedirectResponse("/login", status_code=303)
    storage = db.get(StorageConnection, storage_id)
    clean_path = "/" + "/".join(part for part in path.strip().split("/") if part) if path.strip() else "/"
    if storage is None or (storage.root_path != "/" and clean_path != storage.root_path and not clean_path.startswith(storage.root_path.rstrip("/") + "/")):
        return RedirectResponse(f"/docs?error={quote('Путь находится выше корневой папки')}", status_code=303)
    suffix = clean_path.rsplit("/", 1)[-1].lower()
    if not external_url and suffix.endswith((".drawio", ".drawio.xml", ".canvas")):
        external_url = ""
    kind = node_type if node_type in {"doc", "form", "sheet", "drawio", "canvas", "folder"} else "doc"
    db.add(DocumentNode(storage_id=storage_id, name=name.strip()[:256], path=clean_path, kind=kind, is_folder=kind == "folder", external_url=external_url.strip())); db.commit()
    return RedirectResponse("/docs?success=Элемент добавлен", status_code=303)


@router.post("/docs/nodes/{node_id}/content")
def save_node_content(node_id: int, content: str = Form(""), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None: return RedirectResponse("/login", status_code=303)
    node = next((item for item in allowed_nodes(db, user) if item.id == node_id), None)
    if node is None or node.is_folder: return RedirectResponse("/docs?error=Документ не найден", status_code=303)
    node.content = content[:2_000_000]; db.commit()
    return RedirectResponse(f"/docs?node={node_id}&success=Сохранено", status_code=303)


@router.post("/docs/nodes/{node_id}/permissions")
def set_permission(node_id: int, group_id: int = Form(...), access: str = Form("view"), user: User | None = Depends(get_current_user), db: Session = Depends(get_db)):
    if user is None or not user.is_admin: return RedirectResponse("/docs", status_code=303)
    item = db.scalar(select(DocumentPermission).where(DocumentPermission.node_id == node_id, DocumentPermission.group_id == group_id))
    if item is None: item = DocumentPermission(node_id=node_id, group_id=group_id); db.add(item)
    item.can_edit = access == "edit"; db.commit()
    return RedirectResponse("/docs?success=Доступ обновлён", status_code=303)
