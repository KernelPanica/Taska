from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from taska.constants import (
    APPLICATION_PENDING,
    BLOCKING_ASSIGNEE_STATUSES,
    TASK_STATUS_CLOSED,
    TASK_STATUS_DONE,
)
from taska.models.project import Task, TaskApplication
from taska.models.tag import TagSuggestion
from taska.models.user import User
from taska.services.profiles import get_position_label


def get_user_dashboard(db: Session, user: User) -> dict:
    user = db.scalar(
        select(User).where(User.id == user.id).options(selectinload(User.tags))
    )
    assert user is not None

    assigned_tasks = list(
        db.scalars(
            select(Task)
            .where(Task.assignee_id == user.id)
            .order_by(Task.updated_at.desc())
        ).all()
    )

    active_tasks = [t for t in assigned_tasks if t.status in BLOCKING_ASSIGNEE_STATUSES]
    done_count = sum(1 for t in assigned_tasks if t.status in {TASK_STATUS_DONE, TASK_STATUS_CLOSED})

    pending_applications = db.scalar(
        select(func.count())
        .select_from(TaskApplication)
        .where(TaskApplication.user_id == user.id, TaskApplication.status == APPLICATION_PENDING)
    ) or 0

    pending_tag_suggestions = db.scalar(
        select(func.count())
        .select_from(TagSuggestion)
        .where(TagSuggestion.user_id == user.id, TagSuggestion.status == "pending")
    ) or 0

    current_task = active_tasks[0] if active_tasks else None

    return {
        "display_name": user.display_name or user.username,
        "position_label": get_position_label(user.position_code),
        "experience_years": user.experience_years,
        "tags_count": len(user.tags),
        "active_tasks_count": len(active_tasks),
        "done_tasks_count": done_count,
        "total_assigned": len(assigned_tasks),
        "pending_applications": pending_applications,
        "pending_tag_suggestions": pending_tag_suggestions,
        "current_task": current_task,
        "recent_tasks": assigned_tasks[:5],
        "tags": user.tags,
    }


def update_user_profile(
    db: Session,
    user: User,
    *,
    display_name: str,
    bio: str,
) -> User:
    name = display_name.strip()
    if not name:
        raise ValueError("Укажите отображаемое имя")

    user.display_name = name
    user.bio = bio.strip()
    db.commit()
    db.refresh(user)
    return user


def link_github(db: Session, user: User, *, github_id: int, github_username: str) -> None:
    existing = db.scalar(select(User).where(User.github_id == github_id, User.id != user.id))
    if existing is not None:
        raise ValueError("Этот GitHub уже привязан к другому аккаунту")

    user.github_id = github_id
    user.github_username = github_username
    db.commit()


def unlink_github(db: Session, user: User) -> None:
    user.github_id = None
    user.github_username = None
    db.commit()


def link_telegram(db: Session, user: User, *, telegram_id: int, telegram_username: str | None) -> None:
    existing = db.scalar(select(User).where(User.telegram_id == telegram_id, User.id != user.id))
    if existing is not None:
        raise ValueError("Этот Telegram уже привязан к другому аккаунту")

    user.telegram_id = telegram_id
    user.telegram_username = telegram_username
    db.commit()


def unlink_telegram(db: Session, user: User) -> None:
    user.telegram_id = None
    user.telegram_username = None
    db.commit()


def find_user_by_github(db: Session, github_id: int) -> User | None:
    return db.scalar(select(User).where(User.github_id == github_id))


def find_user_by_telegram(db: Session, telegram_id: int) -> User | None:
    return db.scalar(select(User).where(User.telegram_id == telegram_id))
