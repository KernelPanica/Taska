import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from taska.models.tag import Tag, TagSuggestion
from taska.models.user import User
from taska.services.token_generator import POSITION_CODES, parse_member_token
from taska.utils.datetime import utc_now

TAG_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9а-яА-ЯёЁ\-\+\.# ]{2,64}$")


def normalize_tag_name(name: str) -> str:
    cleaned = " ".join(name.strip().split())
    if not cleaned or not TAG_NAME_PATTERN.match(cleaned):
        msg = "Тег должен быть от 2 до 64 символов (буквы, цифры, пробел, - + . #)"
        raise ValueError(msg)
    return cleaned


def sync_profile_from_token(user: User, member_token: str) -> None:
    parsed = parse_member_token(member_token)
    user.display_name = str(parsed["full_name"])
    user.position_code = str(parsed["position_code"])
    user.experience_years = int(parsed["experience_years"])


def get_position_label(position_code: str | None) -> str:
    if not position_code:
        return "—"
    return POSITION_CODES.get(position_code, position_code)


def list_member_profiles(db: Session) -> list[User]:
    return list(
        db.scalars(
            select(User)
            .where(User.is_admin.is_(False))
            .options(selectinload(User.tags))
            .order_by(User.username)
        ).all()
    )


def get_member_profile(db: Session, username: str) -> User | None:
    user = db.scalar(
        select(User)
        .where(User.username == username)
        .options(selectinload(User.tags), selectinload(User.tag_suggestions))
    )
    if user is None:
        return None

    if user.member_token and not user.display_name:
        try:
            sync_profile_from_token(user, user.member_token)
            db.commit()
            db.refresh(user)
        except ValueError:
            pass

    return user


def list_all_tags(db: Session) -> list[Tag]:
    return list(db.scalars(select(Tag).order_by(Tag.name)).all())


def get_or_create_tag(db: Session, name: str) -> Tag:
    normalized = normalize_tag_name(name)
    tag = db.scalar(select(Tag).where(func.lower(Tag.name) == normalized.lower()))
    if tag is None:
        tag = Tag(name=normalized)
        db.add(tag)
        db.flush()
    return tag


def suggest_tag(db: Session, user: User, tag_name: str) -> TagSuggestion:
    normalized = normalize_tag_name(tag_name)

    existing = db.scalar(
        select(TagSuggestion).where(
            TagSuggestion.user_id == user.id,
            TagSuggestion.tag_name == normalized,
            TagSuggestion.status == "pending",
        )
    )
    if existing is not None:
        msg = "Этот тег уже предложен и ожидает рассмотрения"
        raise ValueError(msg)

    if any(tag.name.lower() == normalized.lower() for tag in user.tags):
        msg = "У вас уже есть этот тег"
        raise ValueError(msg)

    suggestion = TagSuggestion(user_id=user.id, tag_name=normalized, status="pending")
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion


def assign_tag_to_user(db: Session, target: User, tag_name: str, admin: User) -> Tag:
    tag = get_or_create_tag(db, tag_name)
    if tag not in target.tags:
        target.tags.append(tag)
    db.commit()
    db.refresh(target)
    return tag


def remove_tag_from_user(db: Session, target: User, tag_id: int) -> None:
    target.tags = [tag for tag in target.tags if tag.id != tag_id]
    db.commit()


def approve_tag_suggestion(db: Session, suggestion_id: int, admin: User) -> TagSuggestion:
    suggestion = db.get(TagSuggestion, suggestion_id)
    if suggestion is None or suggestion.status != "pending":
        msg = "Предложение не найдено или уже обработано"
        raise ValueError(msg)

    target = db.scalar(
        select(User).where(User.id == suggestion.user_id).options(selectinload(User.tags))
    )
    if target is None:
        msg = "Пользователь не найден"
        raise ValueError(msg)

    tag = get_or_create_tag(db, suggestion.tag_name)
    if tag not in target.tags:
        target.tags.append(tag)

    suggestion.status = "approved"
    suggestion.reviewed_by_id = admin.id
    suggestion.reviewed_at = utc_now()
    db.commit()
    db.refresh(suggestion)
    return suggestion


def reject_tag_suggestion(db: Session, suggestion_id: int, admin: User) -> TagSuggestion:
    suggestion = db.get(TagSuggestion, suggestion_id)
    if suggestion is None or suggestion.status != "pending":
        msg = "Предложение не найдено или уже обработано"
        raise ValueError(msg)

    suggestion.status = "rejected"
    suggestion.reviewed_by_id = admin.id
    suggestion.reviewed_at = utc_now()
    db.commit()
    db.refresh(suggestion)
    return suggestion


def pending_suggestions_for_user(db: Session, user_id: int) -> list[TagSuggestion]:
    return list(
        db.scalars(
            select(TagSuggestion)
            .where(TagSuggestion.user_id == user_id, TagSuggestion.status == "pending")
            .order_by(TagSuggestion.created_at.desc())
        ).all()
    )
