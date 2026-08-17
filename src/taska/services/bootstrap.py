from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from taska.config import get_settings
from taska.constants import TASK_STATUSES
from taska.database import Base, engine
from taska.models.invitation import Invitation
from taska.models.project import Task
from taska.models.site_settings import SiteSettings
from taska.models.user import User
from taska.utils.datetime import utc_now


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_user_profile_columns()
    _migrate_project_columns()
    _migrate_invitation_columns()


def _migrate_invitation_columns() -> None:
    inspector = inspect(engine)
    if "invitations" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("invitations")}
    alterations = {
        "revoked_at": "DATETIME",
        "grants_admin": "BOOLEAN NOT NULL DEFAULT 0",
    }
    with engine.begin() as connection:
        for name, column_type in alterations.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE invitations ADD COLUMN {name} {column_type}"))


def _migrate_project_columns() -> None:
    inspector = inspect(engine)
    alterations = {
        "projects": {"space_id": "INTEGER"},
        "tasks": {
            "ticket_type_id": "INTEGER",
            "parent_id": "INTEGER",
            "due_date": "DATETIME",
            "sprint_id": "INTEGER REFERENCES sprints(id) ON DELETE SET NULL",
            "story_points": "INTEGER NOT NULL DEFAULT 0",
            "priority": "VARCHAR(16) NOT NULL DEFAULT 'medium'",
        },
        "sprints": {"completed_at": "DATETIME", "retrospective": "TEXT NOT NULL DEFAULT ''"},
        "workflow_statuses": {"wip_limit": "INTEGER"},
    }
    with engine.begin() as connection:
        tables = set(inspector.get_table_names())
        for table, columns_to_add in alterations.items():
            if table not in tables:
                continue
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, column_type in columns_to_add.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {column_type}"))


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
        "discord_id": "BIGINT",
        "discord_username": "VARCHAR(64)",
        "discord_avatar_url": "VARCHAR(512)",
        "avatar_data": "BLOB",
        "avatar_mime": "VARCHAR(64)",
        "has_password": "BOOLEAN NOT NULL DEFAULT 1",
        "ui_preferences": "TEXT NOT NULL DEFAULT '{}'",
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
        .where(Invitation.revoked_at.is_(None))
        .where((Invitation.expires_at.is_(None)) | (Invitation.expires_at > utc_now()))
    ) or 0
    task_status_counts = {
        code: db.scalar(select(func.count()).select_from(Task).where(Task.status == code)) or 0
        for code in TASK_STATUSES
    }
    return {
        "users_count": users_count,
        "invitations_count": invitations_count,
        "active_invitations": active_invitations,
        "task_status_counts": task_status_counts,
    }


def get_site_context(db: Session) -> dict[str, str]:
    site = db.scalar(select(SiteSettings).limit(1))
    settings = get_settings()
    if site is None:
        return {
            "app_name": settings.app_name,
            "organization_name": "",
            "base_url": settings.base_url.rstrip("/"),
        }
    return {
        "app_name": settings.app_name or site.app_name,
        "organization_name": site.organization_name,
        "base_url": settings.base_url.rstrip("/"),
    }
