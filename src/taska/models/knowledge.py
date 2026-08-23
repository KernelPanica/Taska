from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Table, Text, Column, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from taska.database import Base

group_members = Table("group_members", Base.metadata,
    Column("group_id", ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True))

task_view_groups = Table("task_view_groups", Base.metadata,
    Column("task_id", ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("group_id", ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True))
task_view_users = Table("task_view_users", Base.metadata,
    Column("task_id", ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True))


class AccessGroup(Base):
    __tablename__ = "access_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(96), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    members = relationship("User", secondary=group_members, back_populates="access_groups")
    visible_tasks = relationship("Task", secondary=task_view_groups, back_populates="view_groups")


class StorageConnection(Base):
    __tablename__ = "storage_connections"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    provider: Mapped[str] = mapped_column(String(32))
    root_path: Mapped[str] = mapped_column(String(512), default="/")
    endpoint: Mapped[str] = mapped_column(String(1024), default="")
    host: Mapped[str] = mapped_column(String(255), default="")
    username: Mapped[str] = mapped_column(String(255), default="")
    password: Mapped[str] = mapped_column(String(1024), default="")
    repository: Mapped[str] = mapped_column(String(256), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DocumentNode(Base):
    __tablename__ = "document_nodes"
    id: Mapped[int] = mapped_column(primary_key=True)
    storage_id: Mapped[int] = mapped_column(ForeignKey("storage_connections.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("document_nodes.id", ondelete="CASCADE"), nullable=True)
    name: Mapped[str] = mapped_column(String(256))
    path: Mapped[str] = mapped_column(String(1024))
    is_folder: Mapped[bool] = mapped_column(Boolean, default=False)
    kind: Mapped[str] = mapped_column(String(32), default="doc")
    content: Mapped[str] = mapped_column(Text, default="")
    external_url: Mapped[str] = mapped_column(String(2048), default="")
    storage = relationship("StorageConnection")
    permissions = relationship("DocumentPermission", cascade="all, delete-orphan")


class DocumentPermission(Base):
    __tablename__ = "document_permissions"
    __table_args__ = (UniqueConstraint("node_id", "group_id", name="uq_document_group_permission"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("document_nodes.id", ondelete="CASCADE"))
    group_id: Mapped[int] = mapped_column(ForeignKey("access_groups.id", ondelete="CASCADE"))
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)
    group = relationship("AccessGroup")
