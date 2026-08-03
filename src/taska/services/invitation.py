from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.security import (
    INVITATION_EXPIRE_DAYS,
    generate_invitation_token,
    hash_password,
    unusable_password_hash,
)
from taska.models.invitation import Invitation
from taska.models.user import User
from taska.utils.datetime import to_naive_utc, utc_now


def create_invitation(db: Session, admin: User) -> Invitation:
    invitation = Invitation(
        token=generate_invitation_token(),
        created_by_id=admin.id,
        expires_at=utc_now() + timedelta(days=INVITATION_EXPIRE_DAYS),
    )
    db.add(invitation)
    db.commit()
    db.refresh(invitation)
    return invitation


def get_valid_invitation(db: Session, token: str) -> Invitation | None:
    invitation = db.scalar(select(Invitation).where(Invitation.token == token))
    if invitation is None or invitation.used_at is not None:
        return None
    if invitation.expires_at and to_naive_utc(invitation.expires_at) < utc_now():
        return None
    return invitation


def list_invitations(db: Session) -> list[Invitation]:
    return list(db.scalars(select(Invitation).order_by(Invitation.created_at.desc())).all())


def _consume_invitation(db: Session, invitation: Invitation, user: User) -> User:
    db.add(user)
    db.flush()
    invitation.used_by_id = user.id
    invitation.used_at = utc_now()
    db.commit()
    db.refresh(user)
    return user


def register_via_invitation(
    db: Session, invitation: Invitation, *, username: str, password: str
) -> User:
    user = User(
        username=username,
        password_hash=hash_password(password),
        has_password=True,
        is_admin=False,
        display_name=username,
    )
    return _consume_invitation(db, invitation, user)


def register_discord_via_invitation(
    db: Session,
    invitation: Invitation,
    *,
    username: str,
    discord_id: int,
    discord_username: str,
    discord_avatar_url: str | None,
) -> User:
    user = User(
        username=username,
        password_hash=unusable_password_hash(),
        has_password=False,
        is_admin=False,
        display_name=discord_username or username,
        discord_id=discord_id,
        discord_username=discord_username,
        discord_avatar_url=discord_avatar_url,
    )
    return _consume_invitation(db, invitation, user)
