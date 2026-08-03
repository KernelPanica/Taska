from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, LargeBinary, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from taska.database import Base
from taska.models.tag import Tag, user_tags

if TYPE_CHECKING:
    from taska.models.passkey import PasskeyCredential
    from taska.models.tag import TagSuggestion


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    has_password: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    display_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    position_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    experience_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    github_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    github_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    telegram_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    telegram_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    discord_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    discord_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    discord_avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    avatar_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    avatar_mime: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tags: Mapped[list[Tag]] = relationship(secondary=user_tags, back_populates="users")
    tag_suggestions: Mapped[list["TagSuggestion"]] = relationship(
        "TagSuggestion",
        foreign_keys="TagSuggestion.user_id",
        back_populates="user",
    )
    passkeys: Mapped[list["PasskeyCredential"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
