from sqlalchemy import func, select
from sqlalchemy.orm import Session

from taska.auth.security import hash_password
from taska.config import get_settings
from taska.models.site_settings import SiteSettings
from taska.models.user import User


def is_setup_required(db: Session) -> bool:
    users_count = db.scalar(select(func.count()).select_from(User)) or 0
    return users_count == 0


def get_site_settings(db: Session) -> SiteSettings | None:
    return db.scalar(select(SiteSettings).limit(1))


def complete_initial_setup(
    db: Session,
    *,
    organization_name: str,
    app_name: str,
    base_url: str,
    admin_username: str,
    admin_password: str,
) -> User:
    if not is_setup_required(db):
        msg = "Первоначальная настройка уже выполнена"
        raise ValueError(msg)

    username = admin_username.strip()
    if not username:
        msg = "Укажите логин администратора"
        raise ValueError(msg)

    org = organization_name.strip()
    if not org:
        msg = "Укажите название организации"
        raise ValueError(msg)

    settings = get_settings()
    site = SiteSettings(
        organization_name=org,
        app_name=app_name.strip() or settings.app_name,
        base_url=base_url.strip().rstrip("/") or settings.base_url,
    )
    admin = User(
        username=username,
        password_hash=hash_password(admin_password),
        is_admin=True,
    )
    db.add(site)
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return admin
