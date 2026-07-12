from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from taska.config import get_settings
from taska.database import Base, engine
from taska.models.invitation import Invitation
from taska.models.site_settings import SiteSettings
from taska.models.user import User
from taska.utils.datetime import utc_now


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_user_profile_columns()


def _migrate_user_profile_columns() -> None:
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("users")}
    alterations = {
        "display_name": "VARCHAR(128)",
        "position_code": "VARCHAR(16)",
        "experience_years": "INTEGER",
        "bio": "TEXT",
        "github_id": "BIGINT",
        "github_username": "VARCHAR(64)",
        "telegram_id": "BIGINT",
        "telegram_username": "VARCHAR(64)",
    }

    with engine.begin() as connection:
        for name, column_type in alterations.items():
            if name not in columns:
                connection.execute(text(f"ALTER TABLE users ADD COLUMN {name} {column_type}"))


def get_admin_stats(db: Session) -> dict[str, int]:
    users_count = db.scalar(select(func.count()).select_from(User)) or 0
    invitations_count = db.scalar(select(func.count()).select_from(Invitation)) or 0
    active_invitations = db.scalar(
        select(func.count())
        .select_from(Invitation)
        .where(Invitation.used_at.is_(None))
        .where((Invitation.expires_at.is_(None)) | (Invitation.expires_at > utc_now()))
    ) or 0
    return {
        "users_count": users_count,
        "invitations_count": invitations_count,
        "active_invitations": active_invitations,
    }


def get_site_context(db: Session) -> dict[str, str]:
    site = db.scalar(select(SiteSettings).limit(1))
    if site is None:
        settings = get_settings()
        return {
            "app_name": settings.app_name,
            "organization_name": "",
            "base_url": settings.base_url.rstrip("/"),
        }
    return {
        "app_name": site.app_name,
        "organization_name": site.organization_name,
        "base_url": site.base_url.rstrip("/"),
    }
