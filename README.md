# agent-Mr — Unified AI Ads Agent

Единый AI-агент, управляющий рекламой одновременно в **Google Ads**, **Яндекс.Директе** и на **Авито**:
чат на естественном языке (RU/EN), общая система безопасности (dry-run, лимиты, подтверждения, audit-log)
и сквозная отчётность по трём площадкам.

Полное техническое задание: [`docs/TZ.md`](docs/TZ.md) (v2.0).

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
| `AGENT_API_KEY` | нет | API-ключ REST API (заголовок `x-api-key`); пусто = без защиты |
| `PUBLIC_URL` | нет | Публичный URL для OAuth redirect-uri |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | prod | Google Ads (этап 3) |
| `YANDEX_OAUTH_CLIENT_ID/SECRET` | prod | Яндекс.Директ (этап 4) |
| `AVITO_CLIENT_ID/SECRET`, `AVITO_USER_ID` | prod | Авито Business API (этап 5) |
| `TELEGRAM_BOT_TOKEN` | для бота | Token от @BotFather (этап 8) |

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
| GET | `/api/health` | Healthcheck |

Аутентификация: при заданном `AGENT_API_KEY` все маршруты (кроме `/api/health` и OAuth)
требуют заголовок `x-api-key`. Веб-UI хранит ключ в localStorage (поле в настройках).

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
Long polling — публичный URL не требуется.

## Тесты

```bash
npm run typecheck   # TypeScript
npm run test        # vitest: rule-парсер, advisor, crypto, format (31 тест)
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

## Следующие шаги (follow-up)

- Интеграция Яндекс.Метрики (конверсии Директа)
- Бюджетные операции Google Ads на стороне платформы (campaign budget resource)
- Мультитенантность и роли пользователей (ТЗ, раздел 13)
- Контроль расходов на LLM (биллинг OpenRouter)
- Интеграционные тесты (playwright) и CI
