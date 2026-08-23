from sqlalchemy import select

from taska.database import get_db
from taska.main import app
from taska.models.role import CustomRole


def test_roles_and_groups_page(client):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.get("/admin/groups")

    assert response.status_code == 200
    assert "Роли и группы" in response.text
    assert "Backend · Senior" in response.text


def test_admin_creates_and_deletes_custom_role(client):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.post("/admin/roles", data={"name": "Аналитик"}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/admin/groups#roles"

    response = client.get("/admin/groups")
    assert "Аналитик" in response.text

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        role = db.scalar(select(CustomRole).where(CustomRole.name == "Аналитик"))
        role_id = role.id
    finally:
        db_gen.close()

    response = client.post(f"/admin/roles/{role_id}/delete", follow_redirects=False)
    assert response.status_code == 303
    assert "Аналитик" not in client.get("/admin/groups").text
