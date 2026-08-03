import base64
import secrets
from datetime import UTC, datetime, timedelta

import bcrypt
from jose import JWTError, jwt

from taska.config import get_settings

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24
WEBAUTHN_CHALLENGE_EXPIRE_MINUTES = 5
SETUP_UNLOCK_EXPIRE_MINUTES = 15
INVITATION_EXPIRE_DAYS = 7


def hash_password(password: str) -> str:
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    return hashed.decode("ascii")


def unusable_password_hash() -> str:
    return hash_password(secrets.token_urlsafe(48))


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("ascii"))


def create_access_token(subject: str, *, is_admin: bool = False) -> str:
    settings = get_settings()
    expire = datetime.now(UTC) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    payload = {"sub": subject, "exp": expire, "adm": is_admin}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    settings = get_settings()
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None


def create_webauthn_challenge_token(challenge: bytes, ceremony: str) -> str:
    settings = get_settings()
    expire = datetime.now(UTC) + timedelta(minutes=WEBAUTHN_CHALLENGE_EXPIRE_MINUTES)
    payload = {
        "challenge": base64.urlsafe_b64encode(challenge).decode("ascii"),
        "ceremony": ceremony,
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_webauthn_challenge_token(token: str, ceremony: str) -> bytes | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        if payload.get("ceremony") != ceremony:
            return None
        return base64.urlsafe_b64decode(payload["challenge"])
    except (JWTError, KeyError, TypeError, ValueError):
        return None


def create_oauth_link_token(username: str) -> str:
    settings = get_settings()
    expire = datetime.now(UTC) + timedelta(minutes=10)
    return jwt.encode(
        {"sub": username, "purpose": "oauth-link", "exp": expire},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def decode_oauth_link_token(token: str) -> str | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        if payload.get("purpose") != "oauth-link":
            return None
        return payload.get("sub")
    except JWTError:
        return None


def create_setup_unlock_token() -> str:
    settings = get_settings()
    expire = datetime.now(UTC) + timedelta(minutes=SETUP_UNLOCK_EXPIRE_MINUTES)
    return jwt.encode(
        {"purpose": "initial-setup", "exp": expire},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def verify_setup_unlock_token(token: str) -> bool:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        return payload.get("purpose") == "initial-setup"
    except JWTError:
        return False


def create_invitation_oauth_token(invitation_token: str) -> str:
    settings = get_settings()
    expire = datetime.now(UTC) + timedelta(minutes=10)
    return jwt.encode(
        {"invitation": invitation_token, "purpose": "invitation-oauth", "exp": expire},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def decode_invitation_oauth_token(token: str) -> str | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        if payload.get("purpose") != "invitation-oauth":
            return None
        return payload.get("invitation")
    except JWTError:
        return None


def generate_invitation_token() -> str:
    return secrets.token_urlsafe(32)

