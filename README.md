# agent-Mr — AI Advertising Operating System

**Единый AI-агент, управляющий рекламой в Google Ads, Яндекс.Директе и на Авито:
один чат, один safety-слой, одна отчётность.**

> **EN pitch.** agent-Mr is an AI advertising operations platform: one agent
> manages campaigns, bids and promotion across Google Ads, Yandex Direct and
> Avito through natural language (RU/EN). Every budget-affecting action goes
> through a deterministic policy engine — read-only by default, dry-run preview,
> spend limits, human approval, full audit log. Three clients of one REST API:
> web UI, Telegram bot and an MCP server (Advertising Control Plane for AI agents).
> **Production status: Yandex Direct — production integration ready (OAuth + API v5 + Metrica);
> Google Ads & Avito — adapters in sandbox.**

**Problem.** Маркетолог ведёт 3 кабинета: три интерфейса, три отчёта, три риска
случайной траты. AI-агенты умеют «говорить про рекламу», но доверять им бюджеты
нельзя — нет guardrails, confirmations и audit.

**Solution.** Execution layer, которому можно доверять: LLM формирует structured
intent → **Policy Engine** решает допуск (read-only по умолчанию, лимиты дня/недели/месяца) →
dry-run предпросмотр → **человек подтверждает** → повторная проверка лимитов →
выполнение → audit-log. LLM никогда не трогает рекламные API напрямую.

| | |
|---|---|
| 🎬 **Демо** | [Живой интерактивный чат (RU/EN)](https://akoffice933-maker.github.io/agent-Mr/) · [видео: аудит + управление](demo/assets/demo-audit.mp4) · [видео: кросс-отчёт](demo/assets/demo-report.mp4) |
| 🛡 **Безопасность** | read-only by default · dry-run · лимиты · approval · re-check · encrypted tokens · fail-closed API auth · rate limiting |
| 📡 **Клиенты** | Web UI · Telegram-бот (`/report` `/audit` `/pending`) · MCP-сервер (6 tools) — один REST API |
| 🏭 **Production** | Яндекс.Директ: готов (OAuth, API v5, Метрика) · Google Ads: sandbox · Авито: sandbox |

Полное техническое задание: [`docs/TZ.md`](docs/TZ.md) (v2.1) · Production Hardening план: [`docs/HARDENING.md`](docs/HARDENING.md) · Гайд подключения Директа: [`docs/YANDEX_SETUP.md`](docs/YANDEX_SETUP.md)

## Как начать за 10 минут

```bash
# 1. Клон и зависимости
git clone https://github.com/akoffice933-maker/agent-Mr.git && cd agent-Mr
npm install

# 2. Переменные окружения
cp .env.example .env
#    минимум: DATABASE_URL + ENCRYPTION_KEY (произвольная строка ≥ 16 символов)

# 3. База данных + демо-данные
npx drizzle-kit migrate     # создаёт схему (12 таблиц)
npm run seed                # кабинет «Ромашка Мебель»: 20 кампаний/объявлений, 28 дней метрик

# 4. Запуск
npm run dev                 # http://localhost:3000
```

Что попробовать в первую очередь (веб-чат или Telegram/MCP):

1. «Покажи расходы за последние 7 дней» — сводка по трём площадкам + совет Advisor
2. «Сравни CPA между Google Ads и Яндекс.Директом»
3. «Сделай аудит всех кабинетов» → «Покажи рекомендации»
4. «Поставь на паузу кампании с CTR ниже 1%» — dry-run предпросмотр → подтверждение
5. Страница **Отчёт** — кросс-платформенная эффективность + рекомендации по переносу бюджета

Без ключей платформы всё работает на демо-данных (sandbox). Для production — см. ниже.

## Production: Яндекс.Директ

Единственная площадка с полным production-путём на сегодня (Директ API v5 + Метрика).
Пошагово — **[`docs/YANDEX_SETUP.md`](docs/YANDEX_SETUP.md)** (15–30 минут):

1. OAuth-приложение в Яндексе (Веб-сервисы + redirect URI)
2. **Заявка на доступ к API** в самом Директе (Инструменты → API) — обязательно
3. `YANDEX_OAUTH_CLIENT_ID/SECRET` в `.env` (+ опционально `METRIKA_API_KEY/COUNTER_ID/GOAL_ID` для конверсий)
4. **Безопасность → Площадки → «Подключить»** → авторизация Яндекса → готово

После подключения агент сразу покажет онбординг: «Вот что я нашёл: N кампаний, расход за 7 дней» + кнопки «Запустить полный аудит» и «Показать рекомендации».

> **По умолчанию агент в режиме «только чтение»** — управляет аккаунтами только после явного включения на странице «Безопасность».

Google Ads и Авито: адаптеры готовы, остаются в sandbox (см. план ниже).

## Демо-видео

- [`demo/assets/demo-audit.mp4`](demo/assets/demo-audit.mp4) — аудит → рекомендации → включение управления → пауза кампаний с подтверждением (35 с)
- [`demo/assets/demo-report.mp4`](demo/assets/demo-report.mp4) — сводный расход + кросс-платформенный отчёт (12 с)
- Статичный демо-сайт с живым чатом (RU/EN): <https://akoffice933-maker.github.io/agent-Mr/>

## 14-дневный план — статус

| Период | Задача | Статус |
|---|---|---|
| День 1 | Регистрация приложения в Яндексе | 📋 гайд готов: `docs/YANDEX_SETUP.md` — осталось выполнить руками |
| Дни 2–3 | Production-адаптер Директа (sync кампаний/статистики/ключей) | ✅ готов (ждёт реальный токен) |
| День 4 | Write-операции: пауза/запуск, ставки, бюджеты, минус-фразы | ✅ готов |
| День 5 | Конверсии из Метрики (reachedGoal по дням) | ✅ готов (ждёт METRIKA_* ключи) |
| День 6 | Preview опасных действий + audit-log | ✅ готов (предпросмотр с before/after, trace, re-check лимитов при подтверждении) |
| День 7 | Полный цикл: подключение → синк → аудит → пауза → отчёт | ⏳ ждёт боевого кабинета |
| Дни 8–9 | Кросс-платформенный отчёт + Advisor | ✅ страница `/report` |
| День 10 | Онбординг после OAuth («вот что я нашёл») | ✅ баннер с авто-синком после подключения |
| День 11 | «Только чтение» по умолчанию + явное включение | ✅ default `readOnly=true` + confirm при включении |
| День 12 | Telegram: отчёты, аудит, pending-действия | ✅ `/report`, `/audit`, `/pending` + кнопки |
| День 13 | Демо-видео | ✅ 2 mp4 в `demo/assets/` |
| День 14 | README «Как начать» | ✅ (этот раздел) |

## Модель безопасности (pipeline)

```
Пользователь (веб / Telegram / MCP)
        ↓
Authentication: session cookie (HttpOnly) | x-api-key (org-scoped machine key)
        ↓
Tenant isolation: session → user → org  +  Postgres RLS (FORCE, fail-closed)
        ↓
[Phase D: RBAC]  →  Policy Engine
        ↓
AI Core: LLM tool calling (OpenRouter) → rule-based fallback
        ↓  structured intent: {tool, platforms, params}
Policy Engine:  read? → allow  |  read-only? → block  |  лимиты? → block
        ↓  require_approval
Safety Layer: dry-run предпросмотр (before/after + стоимость)
        ↓
Подтверждение человека (кнопки / инлайн-кнопки)
        ↓
Policy Engine re-check (лимиты могли исчерпаться)
        ↓
Adapters: production (реальный API) | sandbox (зеркало)
        ↓
PostgreSQL: audit_log · pending_actions · oauth_tokens (AES-256-GCM)
```

> **Р1.** LLM никогда не принимает security decisions — только Policy Engine (код).
> **Р4.** Credentials не живут в браузере: только HttpOnly cookie.

API-защита: в production-режиме без `AGENT_API_KEY` REST API **недоступен**
(fail-closed, 503); rate limiting 120 read/20 write req/min на IP.

## Возможности

- **Управление**: создание кампаний, пауза/запуск (по порогу CTR или по названию), ставки, минус-фразы,
  продвижение объявлений Авито, применение рекомендаций
- **Аналитика**: сводный расход, сравнение CPA между площадками, статистика ключей, чаты/лиды Авито
- **Аудит и рекомендации**: автоматический аудит кабинетов, генерация рекомендаций,
  кросс-платформенные предложения по переносу бюджета (Cross-Platform Advisor)
- **Безопасность**: dry-run по умолчанию, дневные/недельные/месячные лимиты расхода,
  обязательное подтверждение действий, влияющих на бюджет, полный audit-log, режим «только чтение»
- **LLM-ядро**: OpenRouter (tool calling) с автоматическим фолбэком на детерминированный
  rule-based парсер, когда ключ не задан или LLM недоступна
- **Сессия**: контекст диалога (упомянутые кампании, платформы, pending-действия) передаётся в LLM
- **Адаптеры**: sandbox-режим (seed-данные, работает без ключей) и production-режим
  (реальные API + OAuth, токены шифруются в БД AES-256-GCM)
- **Внешние клиенты**: MCP-сервер и Telegram-бот — тонкие прокси того же REST API

## Быстрый старт (локально)

Требования: Node.js 20+, PostgreSQL 14+.

```bash
# 1. Зависимости
npm install

# 2. Переменные окружения
cp .env.example .env        # минимум: DATABASE_URL + ENCRYPTION_KEY

# 3. Схема БД
npx drizzle-kit migrate     # примени drizzle-мigrations
# (если drizzle-kit migrate недоступен: psql -f drizzle/0000_*.sql -f drizzle/0001_*.sql)

# 4. Демо-данные (фирма «Ромашка Мебель»: 6 кампаний Google, 6 Директа, 8 объявлений Авито, 28 дней метрик)
npm run seed

# 5. Запуск
npm run dev                 # http://localhost:3000
```

Попробовать в чате:

```
Покажи расходы за последние 7 дней
Сравни CPA между Google Ads и Яндекс.Директом
Поставь на паузу кампании с CTR ниже 1%
Поставь на паузу «Поиск — Диваны на заказ»
Продвинь объявления на Авито с низким количеством просмотров
Сделай аудит всех подключённых кабинетов
Примени все рекомендации
```

Docker (self-host):

```bash
docker compose up --build                       # app + postgres
docker compose --profile clients up --build     # + telegram-bot + mcp-server
```

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `DATABASE_URL` | да | Строка подключения PostgreSQL |
| `ENCRYPTION_KEY` | да* | Ключ AES-256-GCM для шифрования OAuth-токенов в БД (*обязательна при подключении площадок) |
| `OPENROUTER_API_KEY` | нет | LLM-ядро; без ключа — rule-based парсер |
| `OPENROUTER_MODEL` | нет | Модель по умолчанию: `openai/gpt-4o-mini` |
| `AGENT_API_KEY` | prod* | API-ключ для машиных клиентов (MCP/Telegram), заголовок `x-api-key` |
| `AGENT_AUTH_MODE` | нет | `off` (дефолт, dev/sandbox) / `on` (SaaS: login по сессии) |
| `AGENT_MODE` | нет | `production` включает fail-closed и обязательную аутентификацию |
| `PUBLIC_URL` | нет | Публичный URL для OAuth redirect-uri (https включает Secure cookie) |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | prod | Google Ads (этап 3) |
| `YANDEX_OAUTH_CLIENT_ID/SECRET` | prod | Яндекс.Директ (этап 4) |
| `AVITO_CLIENT_ID/SECRET`, `AVITO_USER_ID` | prod | Авито Business API (этап 5) |
| `TELEGRAM_BOT_TOKEN` | для бота | Token от @BotFather (этап 8) |

### Multi-tenancy (Phase C)

- Данные изолированы на уровне **Postgres RLS (FORCE)**: каждое приложение-соединение
  работает в контексте одной организации (`app.org_id`); без контекста — 0 строк.
- Tenant берётся только из server-side сессии / org-scoped machine key — никогда из тела запроса.
- CLI:
  - `npm run create-user -- <email> <password> [name]` — пользователь + membership в default org
  - `npm run create-api-key -- [name]` — org-scoped ключ для MCP/Telegram (печатается один раз)
- Миграции и сид выполняются привилегированным пользователем БД (BYPASSRLS),
  приложение — под ролью, подчинённой RLS (`DATABASE_URL`).
- Доказательство изоляции: E2E-сценарий двух организаций (17 проверок: кампании,
  pending-действия 404 cross-tenant, machine keys, chat history, RLS fail-closed).
### RBAC (Phase D)

Роли: `owner` · `admin` · `media_buyer` · `analyst` · `viewer` (в `org_members`).

| Действие | viewer | analyst | media_buyer | admin | owner |
|---|---|---|---|---|---|
| Чтение / отчёты / аудит | ✅ | ✅ | ✅ | ✅ | ✅ |
| Рекомендации | ✅ | ✅ | ✅ | ✅ | ✅ |
| Пауза / запуск кампаний | — | — | ✅ | ✅ | ✅ |
| Ставки | — | — | ≤±10% ✅ · ±10–25% кап · >±25% — | ✅ | ✅ |
| Бюджеты / создание / рекомендации-применение | — | — | ✅ подтверждение | ✅ | ✅ |
| Подключение площадок (OAuth) | — | — | — | ✅ | ✅ |
| Safety-настройки | — | — | — | ✅ | ✅ |

Решение принимает центральная функция `authorize({role, action, context})`
(ALLOW / DENY / REQUIRE_APPROVAL / LIMITED) внутри Policy Engine — LLM её
параметры не могут пересилить (правило R1). Крупные изменения (>10 000 ₽
бюджет-дельта, >10% ставки для media_buyer) получают риск-флаг в предпросмотре.

## Подключение реальных площадок (production)

1. Задайте OAuth-ключи платформы в `.env`.
2. На странице **«Безопасность» → «Площадки»** нажмите **«Подключить»** — пройдёт OAuth-флоу,
   токен зашифрованно сохранится в `oauth_tokens`, режим аккаунта станет `production`.
3. Адаптер начнёт синхронизировать данные с реального API в локальное зеркало (unified-модель)
   и отправлять подтверждённые изменения на платформу.

Примечания:

- **Google Ads**: пакет `google-ads` (официальный gRPC-клиент) — опциональная зависимость,
  установите `npm i google-ads` перед прод-использованием; нужен Developer Token.
- **Авито**: доступ к Business API выдаётся партнёрским соглашением (см. ТЗ, раздел 13);
  авторизация — OAuth2 client_credentials (`https://api.avito.ru/token`).
- **Яндекс.Директ**: приложение нужно зарегистрировать в Яндексе; для prod-объёмов — одобрение Яндекса.
- Конверсии Директа приходят из Яндекс.Метрики — отдельный follow-up (ТЗ 8.2).

## REST API

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/agent/chat` | Сообщение агенту `{message}` → `{user, agent}` |
| POST | `/api/agent/action` | Подтверждение/отклонение `{id, decision: "approve"|"reject"}` |
| GET | `/api/agent/pending` | Действия, ожидающие подтверждения |
| GET | `/api/agent/messages` | История чата |
| POST | `/api/agent/clear` | Очистить историю |
| GET | `/api/campaigns?days=7&status=all` | Кампании/объявления с метриками |
| POST | `/api/campaigns/action` | Пауза/запуск/продвижение из UI |
| GET/POST | `/api/settings` | Safety-настройки; `{platform, mode}` — режим площадки |
| GET | `/api/oauth/{google,yandex,avito}?start=1` | Запуск OAuth; callback с `?code=&state=` |
| POST | `/api/auth/login` | `{email, password}` → session cookie (HttpOnly) |
| POST | `/api/auth/logout` | Revocation сессии + очистка cookie |
| GET | `/api/auth/me` | Текущий пользователь / 401 |
| GET | `/api/health` | Healthcheck: db, mode, auth, uptime |

Аутентификация (Phase B, см. `docs/HARDENING.md`):

- **Браузер**: login → server-side session в HttpOnly Secure SameSite=Strict cookie.
  В браузере нет credentials (ни в JS, ни в localStorage). CSRF — заголовок `X-Agent-Csrf`
  на mутациях. Brute-force: 10 login/min + lockout 5 неудач/15 мин.
- **Машиные клиенты** (MCP/Telegram/скрипты): заголовок `x-api-key`.
- **Режимы**: `AGENT_AUTH_MODE=off` (дефолт, sandbox/dev) / `on` (SaaS).
  Fail-closed: production + нет ключа + нет users → 503.
- Создание пользователя: `npm run create-user -- <email> <password> [name]`.

## MCP-сервер (этап 7)

```bash
cd mcp-server && npm install && npm run build
AGENT_API_URL=http://localhost:3000 npm start
```

Инструменты: `agent_chat`, `list_pending_actions`, `approve_action`, `reject_action`,
`spend_report`, `list_campaigns`. Конфигурация для MCP-клиента:

```json
{
  "mcpServers": {
    "agent-mr": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": { "AGENT_API_URL": "http://localhost:3000" }
    }
  }
}
```

Смок-тест против работающего приложения: `npm run selftest`.

## Telegram-бот (этап 8)

```bash
cd telegram-bot && npm install && npm run build
TELEGRAM_BOT_TOKEN=... AGENT_API_URL=http://localhost:3000 npm start
```

Бот проксирует сообщения в `/api/agent/chat`; pending-действия показываются
инлайн-кнопками «✅ Подтвердить / ❌ Отклонить» → `/api/agent/action`.
Команды: `/start`, `/help`, `/report` (сводный расход), `/audit` (полный аудит),
`/pending` (действия, ожидающие подтверждения, с кнопками).
Long polling — публичный URL не требуется.

## Тесты

```bash
npm run typecheck   # TypeScript
npm run test        # vitest: rule-парсер, policy engine, advisor, crypto, auth, format (44 теста)
cd mcp-server && npm run selftest   # MCP против работающего приложения
cd telegram-bot && npm run selftest # форматирование ответов
```

## Архитектура

```
Чат (Next.js) / Telegram-бот / MCP-сервер
        │  REST /api/agent/*
        ▼
Agent Core:  LLM (OpenRouter, tool calling)  →  rule-based fallback
        │    + Session Context (история, сущности)
        ▼
Unified Tool Layer (13 команд, src/lib/agent/tools.ts)
        │
        ▼
Safety Layer: read-only → лимиты (день/неделя/месяц) → dry-run → pending → audit-log
        │
        ▼
Adapters (src/lib/adapters/):  sandbox (локальное зеркало) | production (реальные API)
        │
        ▼
PostgreSQL (Drizzle): campaigns, metrics_daily, keywords, avito_chats,
                      audit_log, pending_actions, oauth_tokens, recommendations, …
```

Подробности: [`docs/TZ.md`](docs/TZ.md).

## Статус по этапам ТЗ

| Этап | Статус |
|---|---|
| 0. Прототип: UI, схема БД, safety, rule-парсер, seed | ✅ |
| 0.1. Код в репозитории | ✅ |
| 1. LLM (OpenRouter, tool calling) + fallback | ✅ (ключ в `.env` не требуется для работы в fallback-режиме) |
| 2. Session Context | ✅ |
| 3–5. Адаптеры Google/Директ/Авито + OAuth + `oauth_tokens` | ✅ (sandbox проверен; production-клиенты ждут боевые ключи) |
| 6. Cross-Platform Advisor | ✅ |
| 7. MCP-сервер | ✅ |
| 8. Telegram-бот | ✅ (ждёт `TELEGRAM_BOT_TOKEN`) |
| 9. Тесты, документация, деплой | ✅ unit-тесты, README, Docker Compose; интеграционные тесты — follow-up |

## Следующие шаги (после 14-дневного плана)

- Полный production-цикл по Директу на боевом кабинете (День 7 плана)
- Бюджетные операции Google Ads на стороне платформы (campaign budget resource) + прод-прогон Google
- Мультитенантность и роли пользователей (ТЗ, раздел 13)
- Контроль расходов на LLM (биллинг OpenRouter)
- Интеграционные тесты (playwright)
