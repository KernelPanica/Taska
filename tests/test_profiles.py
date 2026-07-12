import pytest
from sqlalchemy import select

from taska.database import get_db
from taska.main import app
from taska.models.tag import TagSuggestion


def test_profiles_list_requires_login(client):
    response = client.get("/profiles", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/login"


def test_profiles_list_and_detail(client, member_user):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.get("/profiles")
    assert response.status_code == 200
    assert "Dev One" in response.text
    assert "/profiles/dev1" in response.text

    response = client.get("/profiles/dev1")
    assert response.status_code == 200
    assert "Backend · Middle" in response.text


def test_member_can_suggest_tag(member_client):
    response = member_client.post(
        "/profiles/dev1/suggest-tag",
        data={"tag_name": "Python"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert "success=" in response.headers["location"]


def test_admin_assigns_tag(client, member_user):
    client.post("/login", data={"username": "testadmin", "password": "testpass"})

    response = client.post(
        "/profiles/dev1/tags",
        data={"tag_name": "FastAPI"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = client.get("/profiles/dev1")
    assert "FastAPI" in response.text


def test_admin_approves_suggested_tag(client, member_client, member_user):
    member_client.post(
        "/profiles/dev1/suggest-tag",
        data={"tag_name": "Docker"},
        follow_redirects=False,
    )

    client.post("/login", data={"username": "testadmin", "password": "testpass"})
    response = client.get("/profiles/dev1")
    assert "Docker" in response.text
    assert "Одобрить" in response.text

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        suggestion = db.scalar(select(TagSuggestion).where(TagSuggestion.tag_name == "Docker"))
        suggestion_id = suggestion.id
    finally:
        db_gen.close()

    response = client.post(
        f"/profiles/dev1/suggestions/{suggestion_id}/approve",
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = client.get("/profiles/dev1")
    assert "Docker" in response.text
