from io import BytesIO

from sqlalchemy import select

from taska.database import get_db
from taska.main import app
from taska.models.user import User


def test_member_dashboard(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})

    response = client.get("/")
    assert response.status_code == 200
    assert "Dev One" in response.text
    assert "Дашборд" in response.text or "Привет" in response.text


def test_account_page(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})

    response = client.get("/account")
    assert response.status_code == 200
    assert "Мой профиль" in response.text


def test_passkey_registration_options(member_client):
    response = member_client.post("/auth/passkey/register/options")
    assert response.status_code == 200
    assert response.json()["rp"]["id"] == "localhost"
    assert response.json()["user"]["name"] == "dev1"


def test_account_update(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})

    response = client.post(
        "/account",
        data={"display_name": "Developer One", "bio": "Backend dev"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = client.get("/account")
    assert "Developer One" in response.text
    assert "Backend dev" in response.text


def test_avatar_upload_and_serve(member_client, member_user):
    image = b"\x89PNG\r\n\x1a\n" + b"avatar-data"
    response = member_client.post(
        "/account/avatar",
        files={"avatar": ("avatar.png", BytesIO(image), "image/png")},
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = member_client.get(f"/avatars/{member_user.id}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == image


def test_avatar_upload_accepts_trailing_slash(member_client):
    image = b"\x89PNG\r\n\x1a\n" + b"avatar-data"
    response = member_client.post(
        "/account/avatar/",
        files={"avatar": ("avatar.png", BytesIO(image), "image/png")},
        follow_redirects=False,
    )
    assert response.status_code == 303


def test_discord_identity_does_not_create_user(client, monkeypatch):
    from taska.auth.oauth import OAUTH_STATE_COOKIE

    async def fake_exchange(_: str):
        return {"id": "987654321", "username": "discord-user", "avatar": None}

    monkeypatch.setattr("taska.routes.oauth.exchange_discord_code", fake_exchange)
    client.cookies.set(OAUTH_STATE_COOKIE, "valid-state")
    response = client.get(
        "/auth/discord/callback?code=test&state=valid-state", follow_redirects=False
    )
    assert response.status_code == 303
    assert response.headers["location"].startswith("/login?error=")

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        assert db.scalar(select(User).where(User.discord_id == 987654321)) is None
    finally:
        db_gen.close()


def test_discord_registration_requires_and_consumes_invitation(client, monkeypatch):
    from taska.auth.oauth import OAUTH_STATE_COOKIE
    from taska.auth.security import create_invitation_oauth_token
    from taska.models.invitation import Invitation

    client.post("/login", data={"username": "testadmin", "password": "testpass"})
    client.post("/admin/invitations", follow_redirects=False)
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        invitation = db.scalar(select(Invitation))
        invitation_token = invitation.token
    finally:
        db_gen.close()

    async def fake_exchange(_: str):
        return {"id": "1122334455", "username": "DiscordUser", "avatar": "hash"}

    monkeypatch.setattr("taska.routes.oauth.exchange_discord_code", fake_exchange)
    client.cookies.set(OAUTH_STATE_COOKIE, "valid-state")
    client.cookies.set(
        "taska_invitation_oauth", create_invitation_oauth_token(invitation_token)
    )
    response = client.get(
        "/auth/discord/callback?code=test&state=valid-state", follow_redirects=False
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/"

    db_gen = override()
    db = next(db_gen)
    try:
        user = db.scalar(select(User).where(User.discord_id == 1122334455))
        invitation = db.scalar(select(Invitation).where(Invitation.token == invitation_token))
        assert user is not None
        assert not user.has_password
        assert invitation.used_by_id == user.id
    finally:
        db_gen.close()


def test_staff_page_title(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})

    response = client.get("/profiles")
    assert response.status_code == 200
    assert "Штат организации" in response.text
