import os
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from taska.models.user import User


ENV_FIELDS = {
    "TASKA_APP_NAME": ("Название приложения", "text"),
    "TASKA_DEBUG": ("Режим отладки", "boolean"),
    "TASKA_BASE_URL": ("Публичный URL", "url"),
    "TASKA_WEBAUTHN_RP_ID": ("WebAuthn RP ID", "text"),
    "TASKA_WEBAUTHN_RP_NAME": ("WebAuthn RP Name", "text"),
    "TASKA_WEBAUTHN_ORIGIN": ("WebAuthn Origin", "url"),
    "TASKA_GITHUB_CLIENT_ID": ("GitHub Client ID", "text"),
    "TASKA_GITHUB_CLIENT_SECRET": ("GitHub Client Secret", "password"),
    "TASKA_TELEGRAM_BOT_TOKEN": ("Telegram Bot Token", "password"),
    "TASKA_TELEGRAM_BOT_USERNAME": ("Telegram Bot Username", "text"),
    "TASKA_DISCORD_CLIENT_ID": ("Discord Client ID", "text"),
    "TASKA_DISCORD_CLIENT_SECRET": ("Discord Client Secret", "password"),
}


def env_file_path() -> Path:
    return Path(os.getenv("TASKA_ENV_FILE", "/data/taska.env"))


def read_env_values() -> dict[str, str]:
    path = env_file_path()
    values = {key: os.getenv(key, "") for key in ENV_FIELDS}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in ENV_FIELDS:
            values[key] = value
    return values


def update_env_values(updates: dict[str, str]) -> None:
    path = env_file_path()
    if not path.exists():
        raise ValueError(f"Файл окружения не найден: {path}")
    allowed = {key: str(value).replace("\r", "").replace("\n", "") for key, value in updates.items() if key in ENV_FIELDS}
    lines = path.read_text(encoding="utf-8").splitlines()
    written: set[str] = set()
    result: list[str] = []
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in allowed:
                result.append(f"{key}={allowed[key]}")
                written.add(key)
                continue
        result.append(line)
    for key, value in allowed.items():
        if key not in written:
            result.append(f"{key}={value}")
    path.write_text("\n".join(result).rstrip() + "\n", encoding="utf-8")


def set_administrator(db: Session, actor: User, target: User, enabled: bool) -> None:
    if not actor.is_admin:
        raise ValueError("Недостаточно прав")
    if not enabled and target.is_admin:
        admins = db.scalar(select(func.count()).select_from(User).where(User.is_admin.is_(True))) or 0
        if admins <= 1:
            raise ValueError("Нельзя снять права у последнего администратора")
    target.is_admin = enabled
    db.commit()
