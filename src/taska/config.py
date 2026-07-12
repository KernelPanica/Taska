from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="TASKA_",
        extra="ignore",
    )

    app_name: str = "Taska"
    debug: bool = False
    secret_key: str = "change-me-in-production"
    database_url: str = "sqlite:///./taska.db"
    base_url: str = "http://localhost:8000"

    github_client_id: str = ""
    github_client_secret: str = ""
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
