import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from taska.auth.security import hash_password
from taska.database import Base, get_db
from taska.main import app
from taska.models.user import User
from taska.services.token_generator import build_member_token

os.environ.setdefault("TASKA_DATABASE_URL", "sqlite://")
os.environ.setdefault("TASKA_SECRET_KEY", "test-secret-key-for-tests")
os.environ.setdefault("TASKA_BASE_URL", "http://localhost:8000")


def _create_test_engine():
    return create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def _bind_test_db(monkeypatch, engine):
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    monkeypatch.setattr("taska.database.engine", engine)
    monkeypatch.setattr("taska.database.SessionLocal", TestingSession)

    def override_get_db():
        session = TestingSession()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestingSession


@pytest.fixture
def empty_client(monkeypatch):
    engine = _create_test_engine()
    _bind_test_db(monkeypatch, engine)

    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client

    app.dependency_overrides.clear()


@pytest.fixture
def client(monkeypatch):
    engine = _create_test_engine()
    TestingSession = _bind_test_db(monkeypatch, engine)

    db = TestingSession()
    db.add(
        User(
            username="testadmin",
            password_hash=hash_password("testpass"),
            is_admin=True,
        )
    )
    db.commit()
    db.close()

    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client

    app.dependency_overrides.clear()


@pytest.fixture
def member_user(client):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        member = User(
            username="dev1",
            password_hash=hash_password("memberpass"),
            is_admin=False,
            member_token=build_member_token("B-M", 2, "Dev One"),
            display_name="Dev One",
            position_code="B-M",
            experience_years=2,
        )
        db.add(member)
        db.commit()
        db.refresh(member)
        return member
    finally:
        db_gen.close()


@pytest.fixture
def member_client(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})
    return client
