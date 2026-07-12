from taska.auth.security import decrypt_full_name, encrypt_full_name, hash_password, verify_password
from taska.services.token_generator import build_member_token, parse_member_token


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
    assert response.headers["location"] == "/admin"

    response = empty_client.get("/admin", follow_redirects=True)
    assert response.status_code == 200
    assert "Панель администратора" in response.text
    assert "Acme Team" in response.text


def test_setup_not_available_after_users_exist(client):
    response = client.get("/setup", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/login"


def test_login_page(client):
    response = client.get("/login")
    assert response.status_code == 200
    assert "Вход" in response.text


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


def test_token_roundtrip():
    token = build_member_token("PM-S", 1, "Иванов Иван")
    assert token.startswith("PM-S1_")

    parsed = parse_member_token(token)
    assert parsed["position_code"] == "PM-S"
    assert parsed["experience_years"] == 1
    assert parsed["full_name"] == "Иванов Иван"


def test_name_encryption():
    encrypted = encrypt_full_name("Петров Пётр")
    assert decrypt_full_name(encrypted) == "Петров Пётр"


def test_password_hash():
    hashed = hash_password("secret")
    assert verify_password("secret", hashed)
    assert not verify_password("wrong", hashed)


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


def test_generate_member_token_in_admin(client):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.post(
        "/admin/tokens",
        data={
            "position_code": "F-M",
            "experience_years": "3",
            "full_name": "Сидоров Алексей",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert "generated=" in response.headers["location"]

    response = client.get(response.headers["location"])
    assert response.status_code == 200
    assert "F-M3_" in response.text
    assert "Сидоров Алексей" in response.text
