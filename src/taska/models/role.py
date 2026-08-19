from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from taska.database import Base


class CustomRole(Base):
    __tablename__ = "custom_roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
