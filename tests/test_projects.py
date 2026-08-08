import pytest
from sqlalchemy import select

from taska.auth.security import hash_password
from taska.database import get_db
from taska.main import app
from taska.models.notification import Notification
from taska.models.project import (
    Project,
    Task,
    TaskApplication,
    TaskProgress,
    TaskStatusRequest,
)
from taska.models.tag import Tag
from taska.models.user import User
from taska.services.profiles import assign_tag_to_user


@pytest.fixture
def pm_user(client):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        pm = User(
            username="pm1",
            password_hash=hash_password("pmpass"),
            is_admin=False,
            position_code="PM-S",
            display_name="PM User",
            experience_years=3,
        )
        db.add(pm)
        db.commit()
        db.refresh(pm)
        return pm
    finally:
        db_gen.close()


@pytest.fixture
def dev_with_tag(client, member_user):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        admin = db.scalar(select(User).where(User.username == "testadmin"))
        member = db.scalar(select(User).where(User.username == "dev1"))
        assign_tag_to_user(db, member, "Python", admin)
        return member
    finally:
        db_gen.close()


def test_projects_list_requires_login(client):
    response = client.get("/projects", follow_redirects=False)
    assert response.status_code == 303


def test_pm_creates_project_and_task(client, pm_user):
    client.post("/login", data={"username": "pm1", "password": "pmpass"})

    response = client.post(
        "/projects",
        data={"name": "Taska Web", "description": "Main product"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = db.scalar(select(Project))
        project_id = project.id
        python_tag = Tag(name="Python")
        db.add(python_tag)
        db.commit()
        tag_id = python_tag.id
    finally:
        db_gen.close()

    response = client.post(
        f"/projects/{project_id}/tasks",
        data={
            "title": "API endpoint",
            "description": "Build REST",
            "enforce_single_task": "on",
            "required_tag_ids": str(tag_id),
        },
        follow_redirects=False,
    )
    assert response.status_code == 303


def test_dev_applies_and_pm_approves(client, pm_user, dev_with_tag):
    client.post("/login", data={"username": "pm1", "password": "pmpass"})

    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = Project(name="App", description="", created_by_id=pm_user.id)
        db.add(project)
        db.flush()
        tag = db.scalar(select(Tag).where(Tag.name == "Python"))
        task = Task(
            project_id=project.id,
            title="Fix bug",
            description="",
            created_by_id=pm_user.id,
            status="unassigned",
            enforce_single_task=True,
        )
        db.add(task)
        db.flush()
        task.required_tags.append(tag)
        db.commit()
        project_id, task_id = project.id, task.id
    finally:
        db_gen.close()

    client.post("/login", data={"username": "dev1", "password": "memberpass"})
    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/apply",
        follow_redirects=False,
    )
    assert response.status_code == 303

    client.post("/login", data={"username": "pm1", "password": "pmpass"})
    db_gen = override()
    db = next(db_gen)
    try:
        application = db.scalar(select(TaskApplication))
        app_id = application.id
    finally:
        db_gen.close()

    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/applications/{app_id}/approve",
        follow_redirects=False,
    )
    assert response.status_code == 303

    db_gen = override()
    db = next(db_gen)
    try:
        task = db.get(Task, task_id)
        assert task.status == "in_progress"
        assert task.assignee_id is not None
    finally:
        db_gen.close()


def test_cannot_apply_without_tags(client, pm_user, member_user):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = Project(name="App2", description="", created_by_id=pm_user.id)
        db.add(project)
        db.flush()
        tag = Tag(name="Rust")
        db.add(tag)
        db.flush()
        task = Task(
            project_id=project.id,
            title="Rust task",
            description="",
            created_by_id=pm_user.id,
            status="unassigned",
        )
        db.add(task)
        db.flush()
        task.required_tags.append(tag)
        db.commit()
        project_id, task_id = project.id, task.id
    finally:
        db_gen.close()

    client.post("/login", data={"username": "dev1", "password": "memberpass"})
    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/apply",
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert "error=" in response.headers["location"]


def test_assignee_posts_progress_and_notifies_pm(client, pm_user, member_user):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = Project(name="Progress", description="", created_by_id=pm_user.id)
        db.add(project)
        db.flush()
        task = Task(
            project_id=project.id,
            title="Ship feature",
            description="",
            created_by_id=pm_user.id,
            assignee_id=member_user.id,
            status="in_progress",
        )
        db.add(task)
        db.commit()
        project_id, task_id = project.id, task.id
    finally:
        db_gen.close()

    client.post("/login", data={"username": "dev1", "password": "memberpass"})
    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/progress",
        data={"body": "API finished", "percent": "70"},
        follow_redirects=False,
    )
    assert response.status_code == 303

    db_gen = override()
    db = next(db_gen)
    try:
        progress = db.scalar(select(TaskProgress))
        assert progress.body == "API finished"
        assert progress.percent == 70
        notification = db.scalar(select(Notification).where(Notification.user_id == pm_user.id))
        assert notification is not None
    finally:
        db_gen.close()


def test_assignee_requests_status_and_pm_approves(client, pm_user, member_user):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = Project(name="Review", description="", created_by_id=pm_user.id)
        db.add(project)
        db.flush()
        task = Task(
            project_id=project.id,
            title="Ready for review",
            description="",
            created_by_id=pm_user.id,
            assignee_id=member_user.id,
            status="in_progress",
        )
        db.add(task)
        db.commit()
        project_id, task_id = project.id, task.id
    finally:
        db_gen.close()

    client.post("/login", data={"username": "dev1", "password": "memberpass"})
    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/status-request",
        data={"requested_status": "in_review", "message": "Please review"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    db_gen = override()
    db = next(db_gen)
    try:
        status_request = db.scalar(select(TaskStatusRequest))
        request_id = status_request.id
        assert status_request.status == "pending"
    finally:
        db_gen.close()
    client.post("/login", data={"username": "pm1", "password": "pmpass"})
    response = client.post(
        f"/projects/{project_id}/tasks/{task_id}/status-requests/{request_id}/approve",
        follow_redirects=False,
    )
    assert response.status_code == 303
    db_gen = override()
    db = next(db_gen)
    try:
        task = db.get(Task, task_id)
        status_request = db.get(TaskStatusRequest, request_id)
        assert task.status == "in_review"
        assert status_request.status == "approved"
        notification = db.scalar(
            select(Notification).where(
                Notification.user_id == member_user.id,
                Notification.title == "Запрос статуса одобрен",
            )
        )
        assert notification is not None
    finally:
        db_gen.close()


def test_pm_can_add_custom_status_and_use_kanban(client, pm_user):
    override = app.dependency_overrides[get_db]
    db_gen = override()
    db = next(db_gen)
    try:
        project = Project(name="Kanban", description="", created_by_id=pm_user.id)
        db.add(project)
        db.commit()
        project_id = project.id
    finally:
        db_gen.close()
    client.post("/login", data={"username": "pm1", "password": "pmpass"})
    response = client.post(
        f"/projects/{project_id}/statuses",
        data={"name": "Готово к релизу"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    response = client.get(f"/projects/{project_id}/board")
    assert response.status_code == 200
    assert "Готово к релизу" in response.text
