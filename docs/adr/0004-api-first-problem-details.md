# 0004. Всё через документированный API; единый формат ошибок

- Статус: принято, 2026-11-16
- Требования: карточка, п. 3 и цель 2 (на том же API заработают помощник и мобильное приложение); R-2.40, R-2.32 — сверить

## Решение

- Веб-интерфейс не имеет «своего» серверного рендеринга данных: всё — через `/api/v1/*`. Версия в пути; несовместимые изменения — только в `/api/v2`.
- **OpenAPI** генерируется из JSON-схем маршрутов Fastify: `/api/openapi.json`, интерфейс — `/api/docs`. Маршрут без схемы на ревью не принимается.
- **Ошибки** — RFC 9457 Problem Details, `Content-Type: application/problem+json`:

  ```json
  {
    "type": "https://yourtask.dev/errors/validation_failed",
    "title": "Validation failed",
    "status": 400,
    "code": "validation_failed",
    "detail": "body/locale must be equal to one of the allowed values",
    "instance": "/api/v1/me",
    "requestId": "2b0c…",
    "errors": [{ "field": "locale", "message": "must be equal to one of the allowed values" }]
  }
  ```

  Клиенты переводят ошибку по `code` (перечень — `ERROR_CODES` в `packages/contracts`), `detail` — для разработчика. `requestId` совпадает с заголовком `x-request-id` и записью в журнале.

- Общие типы запросов и ответов — в `packages/contracts`.
- Навигационные эндпоинты входа (`/auth/login`, `/auth/callback`) отвечают редиректами; ошибки входа передаются как `/login?error=<code>` с теми же кодами.

## Последствия

- Новый код ошибки = запись в `ERROR_CODES` + перевод в обоих словарях (тест проверяет).
