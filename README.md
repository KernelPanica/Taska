# Taska

Taska — небольшое self-hosted веб-приложение для распределения задач между участниками команды. Приложение предоставляет HTML-интерфейс на FastAPI и хранит данные через SQLAlchemy (по умолчанию — в SQLite).

## Quick Start через Docker

Понадобится Docker с Compose v2. В Linux, macOS, WSL или Git Bash выполните:

```bash
git clone <URL-репозитория>
cd Taska-1
sh quick-start.sh
```

Скрипт автоматически:

- сгенерирует уникальные `TASKA_SECRET_KEY` и `TASKA_SETUP_KEY`;
- сохранит их в игнорируемый Git файл `.env.quick-start` с ограниченными правами;
- соберёт Docker-образ и запустит приложение в фоне;
- выведет адрес `/setup` и ключ создания первого администратора.

Откройте [http://localhost:8000/setup](http://localhost:8000/setup) и используйте показанный скриптом setup-ключ. База SQLite хранится в Docker volume `taska-data` и сохраняется между перезапусками.

```bash
# Логи
docker compose logs -f taska

# Остановка без удаления данных
docker compose down

# Полное удаление вместе с базой
docker compose down -v
```

Для другого локального порта:

```bash
TASKA_PORT=8080 sh quick-start.sh
```

Порт записывается в WebAuthn-настройки при первом создании `.env.quick-start`. Если файл уже существует, измените в нём `TASKA_BASE_URL` и `TASKA_WEBAUTHN_ORIGIN` вручную либо удалите файл и снова запустите скрипт (ключ первоначальной настройки при этом изменится).

Этот quick start предназначен для локального запуска. Для публичного деплоя настройте HTTPS и реальные `TASKA_BASE_URL`, `TASKA_WEBAUTHN_RP_ID` и `TASKA_WEBAUTHN_ORIGIN` в `.env.quick-start` перед регистрацией passkey.

## Возможности

- первичная настройка организации и создание администратора через `/setup`;
- вход по логину и паролю, выход с очисткой cookie-сессии;
- опциональная авторизация и привязка профиля через GitHub OAuth и Telegram Login;
- вход по passkey через Windows Hello, биометрию Android или аппаратный ключ;
- приглашения участников по одноразовой ссылке;
- профили сотрудников с должностью, стажем, описанием и тегами;
- предложения тегов участниками и модерация администратором;
- проекты и задачи, которые создают PM и администраторы;
- отклики участников на задачи, проверка обязательных тегов и ограничение одной активной задачи;
- статусы задач: `unassigned`, `in_progress`, `in_review`, `paused`, `needs_changes`, `done`, `closed`;
- административная панель и генерация member-токенов.

## Требования

- Python 3.11 или новее;
- `pip` и виртуальное окружение;
- SQLite для локального запуска либо совместимая база данных SQLAlchemy.

## Запуск без Docker

```powershell
git clone <URL-репозитория>
cd Taska-1
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
Copy-Item .env.example .env
python -m taska.main
```

Перед первым запуском обязательно сгенерируйте секретный deploy-ключ и запишите его в `TASKA_SETUP_KEY`:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

После запуска откройте [http://localhost:8000](http://localhost:8000). При пустой базе приложение автоматически перенаправит на `/setup`. Создание первого администратора разрешено только при вводе deploy-ключа из окружения. Заполните организацию, URL приложения и данные администратора (пароль — минимум 8 символов). База и таблицы создаются при старте приложения.

Также доступна консольная команда, установленная из `pyproject.toml`:

```powershell
taska
```

Для запуска без reload можно выставить `TASKA_DEBUG=false` в `.env` и запускать приложение через Uvicorn:

```powershell
uvicorn taska.main:app --host 0.0.0.0 --port 8000
```

## Конфигурация

Настройки читаются из `.env` с префиксом `TASKA_`. Актуальный шаблон находится в [.env.example](.env.example).

| Переменная | Назначение | Значение по умолчанию |
| --- | --- | --- |
| `TASKA_APP_NAME` | имя приложения до первичной настройки | `Taska` |
| `TASKA_DEBUG` | debug и auto-reload | `false` |
| `TASKA_SECRET_KEY` | ключ подписи JWT и шифрования данных | `change-me-in-production` |
| `TASKA_DATABASE_URL` | URL базы SQLAlchemy | `sqlite:///./taska.db` |
| `TASKA_BASE_URL` | внешний URL приложения | `http://localhost:8000` |
| `TASKA_SETUP_KEY` | секретный ключ создания первого администратора (минимум 32 символа) | пусто |
| `TASKA_WEBAUTHN_RP_ID` | домен WebAuthn без схемы и порта | `localhost` |
| `TASKA_WEBAUTHN_RP_NAME` | имя сервиса в диалоге passkey | `Taska` |
| `TASKA_WEBAUTHN_ORIGIN` | точный origin приложения для проверки passkey | `http://localhost:8000` |
| `TASKA_GITHUB_CLIENT_ID` / `TASKA_GITHUB_CLIENT_SECRET` | GitHub OAuth | пусто |
| `TASKA_TELEGRAM_BOT_TOKEN` / `TASKA_TELEGRAM_BOT_USERNAME` | Telegram Login Widget | пусто |

Перед публикацией замените `TASKA_SECRET_KEY` и `TASKA_SETUP_KEY` на разные длинные случайные значения и отключите debug. После создания администратора setup-маршрут автоматически закрывается. OAuth-провайдеры необязательны: соответствующие кнопки появляются только при заполненной конфигурации.

Passkey требует HTTPS, кроме разработки на `localhost`. Например, для `https://taska.example.com` задайте `TASKA_WEBAUTHN_RP_ID=taska.example.com` и `TASKA_WEBAUTHN_ORIGIN=https://taska.example.com`. RP ID и origin нельзя менять после регистрации passkey без повторной привязки устройств.

## Роли и рабочий процесс

- Администратор создаёт приглашения, управляет профилями и тегами, а также видит административную статистику.
- Пользователь регистрируется по приглашению и указывает member-токен. Токен содержит код должности, стаж и зашифрованное ФИО; профиль заполняется автоматически.
- После обычного входа пользователь может безопасно привязать GitHub, Telegram и несколько passkey. Эти способы входа не создают новые аккаунты и работают только с уже приглашённым пользователем.
- PM (код должности начинается с `PM-`) создаёт проекты и задачи, задаёт обязательные теги и рассматривает отклики.
- Участник видит доступные задачи и может подать заявку, если у него есть все обязательные теги. После одобрения задача переходит в `in_progress`.

Основные страницы: `/`, `/login`, `/projects`, `/profiles`, `/account`, `/admin`, `/health`.

## Разработка

Запуск тестов:

```powershell
pytest
```

Проверка стиля:

```powershell
ruff check .
```

Тесты используют отдельную временную SQLite-базу и не должны изменять локальный `taska.db`. Файлы базы (`*.db`, `*.sqlite3`), `.env`, кэш и виртуальные окружения исключены из Git.

## Структура проекта

```text
src/taska/
├── main.py              # FastAPI-приложение, middleware и запуск
├── config.py            # настройки из окружения
├── database.py          # SQLAlchemy engine/session
├── models/              # User, Project, Task, Invitation, Tag и настройки сайта
├── routes/              # HTML-маршруты setup/auth/dashboard/admin/projects/profiles
├── services/            # бизнес-логика setup, аккаунтов, приглашений и задач
├── auth/                # cookie/JWT, пароли и OAuth
├── templates/           # Jinja2-шаблоны интерфейса
└── static/              # CSS
tests/                   # интеграционные тесты маршрутов и сервисов
```

## API и документация

Приложение в основном ориентировано на HTML-формы. FastAPI также автоматически публикует OpenAPI по адресу `/openapi.json` и Swagger UI по `/docs`.

## Лицензия

Проект распространяется по лицензии MIT.
