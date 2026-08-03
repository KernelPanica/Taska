from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from taska.models.notification import Notification
from taska.models.user import User


def create_notification(
    db: Session, user_id: int, *, title: str, body: str = "", url: str = "/"
) -> Notification:
    notification = Notification(user_id=user_id, title=title, body=body, url=url)
    db.add(notification)
    return notification


def notify_users(
    db: Session, user_ids: set[int], *, title: str, body: str = "", url: str = "/"
) -> None:
    for user_id in user_ids:
        create_notification(db, user_id, title=title, body=body, url=url)


def pm_user_ids(db: Session) -> set[int]:
    users = db.scalars(
        select(User).where((User.is_admin.is_(True)) | (User.position_code.like("PM-%")))
    )
    return {user.id for user in users}


def list_notifications(db: Session, user_id: int) -> list[Notification]:
    return list(
        db.scalars(
            select(Notification)
            .where(Notification.user_id == user_id)
            .order_by(Notification.created_at.desc())
            .limit(100)
        ).all()
    )


def unread_count(db: Session, user_id: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user_id, Notification.is_read.is_(False))
        )
        or 0
    )


def mark_all_read(db: Session, user_id: int) -> None:
    db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    db.commit()
