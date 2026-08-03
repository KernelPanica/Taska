import hashlib
import hmac
import time

from sqlalchemy import select

from taska.auth.oauth import verify_telegram_auth
from taska.auth.security import hash_password, verify_password
from taska.config import get_settings
from taska.database import get_db
from taska.main import app
from taska.models.user import User


def test_health_check(empty_client):
    response = empty_client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_empty_db_redirects_to_setup(empty_client):
    response = empty_client.get("/", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/setup"

    response = empty_client.get("/setup")
    assert response.status_code == 200
    assert "Первый запуск" in response.text


def test_complete_initial_setup(empty_client):
    response = empty_client.post(
        "/setup/unlock",
        data={"setup_key": "test-setup-key-that-is-at-least-32-characters-long"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/setup"

    response = empty_client.post(
        "/setup",
        data={
            "organization_name": "Acme Team",
            "app_name": "Acme Taska",
            "base_url": "http://localhost:8000",
            "admin_username": "owner",
            "admin_password": "securepass",
            "admin_password_confirm": "securepass",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"].startswith("/login?success=")

    response = empty_client.post(
        "/login",
        data={"username": "owner", "password": "securepass"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = empty_client.get("/admin", follow_redirects=True)
    assert response.status_code == 200
    assert "Панель администратора" in response.text
    assert "Acme Team" in response.text


def test_initial_setup_rejects_wrong_deployment_key(empty_client):
    response = empty_client.post(
        "/setup/unlock",
        data={"setup_key": "wrong-key"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert "error=" in response.headers["location"]


def test_setup_form_requires_unlocked_cookie(empty_client):
    response = empty_client.post(
        "/setup",
        data={
            "organization_name": "Acme Team",
            "admin_username": "owner",
            "admin_password": "securepass",
            "admin_password_confirm": "securepass",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/setup"


def test_setup_not_available_after_users_exist(client):
    response = client.get("/setup", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/login"


def test_login_page(client):
    response = client.get("/login")
    assert response.status_code == 200
    assert "Вход" in response.text


def test_passkey_login_options(client):
    response = client.post("/auth/passkey/login/options")
    assert response.status_code == 200
    assert response.json()["rpId"] == "localhost"
    assert response.cookies.get("taska_webauthn_challenge")


def test_admin_login_and_panel(client):
    response = client.post(
        "/login",
        data={"username": "testadmin", "password": "testpass"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/"

    response = client.get("/", follow_redirects=True)
    assert response.status_code == 200
    assert "Панель администратора" in response.text


def test_password_hash():
    hashed = hash_password("secret")
    assert verify_password("secret", hashed)
    assert not verify_password("wrong", hashed)


def test_telegram_login_signature_and_expiration():
    settings = get_settings()
    original_token = settings.telegram_bot_token
    settings.telegram_bot_token = "123456:test-bot-token"
    try:
        data = {
            "id": "123456789",
            "username": "taska_user",
            "auth_date": str(int(time.time())),
        }
        check_string = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
        secret = hashlib.sha256(settings.telegram_bot_token.encode()).digest()
        data["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        assert verify_telegram_auth(data)

        data["auth_date"] = str(int(time.time()) - 601)
        assert not verify_telegram_auth(data)
    finally:
        settings.telegram_bot_token = original_token


def test_create_invitation(client):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.post("/admin/invitations", follow_redirects=False)
    assert response.status_code == 303

    response = client.get("/admin/invitations")
    assert response.status_code == 200
    assert "/invite/" in response.text


def test_expired_invitation_rejected(client):
    from datetime import timedelta

    from sqlalchemy import select

    from taska.database import get_db
    from taska.main import app
    from taska.models.invitation import Invitation
    from taska.utils.datetime import utc_now

    client.post("/login", data={"username": "testadmin", "password": "testpass"})
    client.post("/admin/invitations", follow_redirects=False)

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        invitation = db.scalar(select(Invitation))
        invitation.expires_at = utc_now() - timedelta(days=1)
        db.commit()
        token = invitation.token
    finally:
        db_gen.close()

    response = client.get(f"/invite/{token}")
    assert response.status_code == 200
    assert "недействительна" in response.text


def test_password_registration_uses_only_invitation(client):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})
    client.post("/admin/invitations", follow_redirects=False)
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        from taska.models.invitation import Invitation

        invitation = db.scalar(select(Invitation))
        token = invitation.token
    finally:
        db_gen.close()
    response = client.post(
        f"/invite/{token}",
        data={"username": "new-user", "password": "securepass"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    db_gen = override()
    db = next(db_gen)
    try:
        user = db.scalar(select(User).where(User.username == "new-user"))
        assert user is not None
        assert user.has_password
        assert user.position_code is None
    finally:
        db_gen.close()


