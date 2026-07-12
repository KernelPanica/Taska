from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.security import INVITATION_EXPIRE_DAYS, generate_invitation_token, hash_password
from taska.models.invitation import Invitation
from taska.models.user import User
from taska.services.profiles import sync_profile_from_token
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


def register_via_invitation(
    db: Session,
    invitation: Invitation,
    *,
    username: str,
    password: str,
    member_token: str,
) -> User:
    user = User(
        username=username,
        password_hash=hash_password(password),
        is_admin=False,
        member_token=member_token,
    )
    sync_profile_from_token(user, member_token)
    db.add(user)
    db.flush()

    invitation.used_by_id = user.id
    invitation.used_at = utc_now()
    db.commit()
    db.refresh(user)
    return user
