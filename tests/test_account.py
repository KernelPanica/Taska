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


def test_staff_page_title(client, member_user):
    client.post("/login", data={"username": "dev1", "password": "memberpass"})

    response = client.get("/profiles")
    assert response.status_code == 200
    assert "Штат организации" in response.text
