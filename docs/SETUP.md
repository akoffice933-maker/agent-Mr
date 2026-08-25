# Установка agent-Mr — полный гайд

Всё, что нужно, чтобы запустить агент-оператор рекламы локально (или self-host)
и подключить реальные рекламные кабинеты.

## Требования

- **Node.js 20+**
- **PostgreSQL 14+** (локально или Docker)
- ~1 ГБ диска (зависимости)

## Способ 1: Docker Compose (рекомендуется)

```bash
git clone https://github.com/akoffice933-maker/agent-Mr.git && cd agent-Mr
cp .env.example .env
# в .env: ENCRYPTION_KEY (произвольная строка ≥ 16 символов)
docker compose up --build
```

- Приложение: http://localhost:3000
- Postgres: localhost:5432 (`appuser`/`apppass`, база `app_db`)
- Миграции применяются автоматически при старте приложения
  (схема из `drizzle/`). Демо-данные — `docker compose exec app npm run seed`.
- Дополнительно (профили):
  ```bash
  docker compose --profile clients up --build   # + telegram-bot + mcp-server
  ```

## Способ 2: вручную (Node + ваш Postgres)

### 1. PostgreSQL

Два варианта.

**a) Docker (без установки Postgres):**
```bash
docker run -d --name agentmr-db -p 5432:5432 \
  -e POSTGRES_USER=appuser -e POSTGRES_PASSWORD=apppass -e POSTGRES_DB=app_db \
  postgres:16-alpine
```

**b) Системный Postgres** (Ubuntu/Debian):
```bash
sudo apt install postgresql
sudo -u postgres psql -c "CREATE ROLE appuser LOGIN PASSWORD 'apppass';"
sudo -u postgres psql -c "CREATE DATABASE app_db OWNER appuser;"
```

> Приложение работает под ролью `appuser` (подчинённой RLS). Создавать базу
> и применять миграции можно и этой же ролью — в нашей схеме `appuser` является
> owner всех таблиц, а RLS включён с `FORCE`, так что owner тоже подчиняется
> политикам (это проверено интеграционным тестом).

### 2. Зависимости и переменные

```bash
git clone https://github.com/akoffice933-maker/agent-Mr.git && cd agent-Mr
npm install
cp .env.example .env
```

Минимум для старта:

```env
DATABASE_URL=postgresql://appuser:apppass@127.0.0.1:5432/app_db
ENCRYPTION_KEY=произвольная-строка-минимум-16-символов
```

Полный список переменных — в таблице «Переменные окружения» в README
и в `.env.example` (с комментариями).

### 3. Схема и демо-данные

```bash
npm run migrate   # применяет миграции drizzle/ (5 файлов)
npm run seed      # демо-кабинет «Ромашка Мебель»: 20 кампаний, 28 дней метрик
```

### 4. Запуск

```bash
npm run dev       # http://localhost:3000
```

Первый экран — чат с агентом. Всё работает на демо-данных **без ключей платформ**.

## Первый запуск: что попробовать

| # | Написать в чат | Что произойдёт |
|---|---|---|
| 1 | «Покажи расходы за последние 7 дней» | сводка по 3 площадкам + совет Advisor |
| 2 | «Сравни CPA между Google Ads и Яндекс.Директом» | таблица CPA + вывод |
| 3 | «Сделай аудит всех кабинетов» | аудит + список рекомендаций |
| 4 | «Поставь на паузу кампании с CTR ниже 1%» | **dry-run предпросмотр** (before/after + стоимость) → кнопки «Подтвердить/Отклонить» |
| 5 | Страница **Отчёт** | кросс-платформенная эффективность + предложения по переносу бюджета |

По умолчанию агент в режиме **«только чтение»**: действия, влияющие на бюджет,
нужно разрешить на странице **Безопасность** (см. [USAGE.md](USAGE.md)).

## Реальные кабинеты (production)

Общий порядок для любой площадки:

1. Ключи платформы — в `.env` (см. ниже).
2. Перезапуск приложения.
3. Страница **Безопасность → Площадки → «Подключить»** → OAuth-флоу в браузере.
4. Токен зашифрованно сохранён (AES-256-GCM), режим аккаунта → `production`,
   агент делает первый синхронный sync и показывает онбординг
   («Вот что я нашёл: N кампаний, расход за 7 дней…»).

### Яндекс.Директ — полный production-путь

Пошагово (15–30 минут): **[YANDEX_SETUP.md](YANDEX_SETUP.md)**. Кратко:

1. OAuth-приложение в Яндексе (Веб-сервисы, redirect `http://localhost:3000/api/oauth/yandex`).
2. **Заявка на доступ к API** в самом Директе (Инструменты → API → Мои заявки) —
   без одобренной заявки API вернёт ошибку 58. Срок рассмотрения — до 7 дней.
3. `YANDEX_OAUTH_CLIENT_ID/SECRET` в `.env`.
4. Конверсии (опционально): `METRIKA_API_KEY/COUNTER_ID/GOAL_ID`.

> Для локальной отладки без реальной учётки: `YANDEX_SIMULATOR=1` включает
> встраиваемый симулятор Direct API (тот же контракт v5) — полный цикл
> «создание кампании → read-back → VERIFIED» можно прогнать без денег.

### Google Ads

`GOOGLE_OAUTH_CLIENT_ID/SECRET` + `GOOGLE_ADS_DEVELOPER_TOKEN` +
`GOOGLE_ADS_CUSTOMER_ID`; перед прод-использованием — `npm i google-ads`
(официальный gRPC-клиент, опциональная зависимость).

### Авито

Доступ к Business API выдаётся партнёрским соглашением; ключи
`AVITO_CLIENT_ID/SECRET/USER_ID` из ЛК Авито → Настройки → API.

## Production-режим (SaaS / публичный деплой)

```env
AGENT_MODE=production        # fail-closed: без аутентификации API недоступен (503)
AGENT_API_KEY=...            # ключ для машиных клиентов (MCP/Telegram), заголовок x-api-key
PUBLIC_URL=https://ваш-домен  # для OAuth redirect и Secure cookie
```

Пользователи и роли:

```bash
npm run create-user -- user@example.com <пароль> "Имя"
npm run create-api-key -- "mcp-server"   # org-scoped ключ (печатается один раз)
```

Роли: `owner` · `admin` · `media_buyer` · `analyst` · `viewer`
(максимальные права у `owner` — смена роли: таблица `org_members`).

## Проверка установки

```bash
curl -s http://localhost:3000/api/health
# {"ok":true,"db":true,"mode":"development","auth":"open","uptimeSec":...}

npm run typecheck && npm run test   # 91 тест, включая RLS-аудит и execution pipeline
```

## Частые проблемы

| Симптом | Решение |
|---|---|
| `DATABASE_URL is required` | не заполнен `.env` (файл должен называться именно `.env` или `.env.local`) |
| `password authentication failed` | проверьте роля/пароль в `DATABASE_URL` против Postgres |
| `ENCRYPTION_KEY ... required` при OAuth | задайте `ENCRYPTION_KEY` (≥ 16 символов) и перезапустите |
| Direct API: `error 58: Incomplete registration` | заявка на доступ к API Директа не одобрена (YANDEX_SETUP.md §2) |
| OAuth: `redirect_uri mismatch` | redirect URI в `.env`/`PUBLIC_URL` должен совпадать с зарегистрированным в приложении Яндекса |
| MCP/Telegram не видят действия | задайте обоим `AGENT_API_KEY` (тот же, что приложении) |
