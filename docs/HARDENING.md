# Production Hardening v1 — roadmap

Документ превращает внешнее ревью (авг 2026) в план работ. Главный принцип:
**не 20 новых AI-фич, а production-готовность execution layer**.

Критерий «production-ready»: системе можно доверить рекламные бюджеты первого
реального клиента без риска неконтролируемых действий.

## Фаза A — обязательный периметр (выполняется первой)

| # | Задача | Статус |
|---|---|---|
| A1 | **Mandatory API auth**: в production-режиме (`NODE_ENV=production` или `AGENT_MODE=production`) без `AGENT_API_KEY` API **недоступен** (503 fail-closed), а не открыт. Dev остаётся без трения. | ✅ `src/lib/auth-policy.ts` + `src/proxy.ts` |
| A2 | **Policy Engine** — выделенный детерминированный слой: `allow / require_approval / block`. LLM/парсер только формируют structured intent, решения о допуске принимает `evaluatePolicy()`. Одна и та же оценка — до выполнения и повторно при подтверждении. | ✅ `src/lib/agent/policy.ts` + 6 unit-тестов |
| A3 | **Rate limiting** по IP: read 120 req/min, write 20 req/min, 429 + Retry-After. In-memory (single instance); для multi-instance — вынести в Redis. | ✅ `src/proxy.ts` |
| A4 | **Idempotency** действий: повторный approve/reject того же pending-действия безопасен (проверка статуса, «уже обработано»). Явная Idempotency-Key шапка — фаза B. | ✅ (существующая механика `pending_actions.status`) |
| A5 | **Observability-база**: `/api/health` возвращает db, mode, auth, uptime. Структурные логи — фаза B. | ✅ |

## Фаза B — session-аутентификация (вытесняет localStorage)

Сегодня web-UI хранит API-ключ в `localStorage` — уязвимо к XSS (ключ → действия
с бюджетами). План:

1. **HttpOnly Secure SameSite=Strict cookie** + server-side session (в БД или в Redis):
   - `POST /api/auth/login` (email + пароль / passkey) → session cookie
   - `POST /api/auth/logout`
   - session в `sessions` (id, user_id, expires_at, ip, ua), TTL 12ч, sliding
2. **CSRF**: SameSite cookie + `X-Requested-With`/custom header проверка на mутации
3. REST-клиенты (MCP/Telegram) остаются на `x-api-key` — это machine-to-machine
4. Удаляем `agent_api_key` из localStorage; UI ходит под сессией

## Фаза C — Multi-tenancy

Целевая модель (SaaS):

```
Organization
 ├── users (org_member: role)
 ├── ad_accounts (platform: google|yandex|avito)
 │    └── oauth_tokens (org-scoped, encrypted)
 ├── campaigns / metrics / keywords / chats
 ├── pending_actions (who proposed / who approved)
 ├── audit_log (org-scoped)
 └── billing
```

- Каждая бизнес-сущность получает `organization_id` (FK, indexed);
  `user_id` — у pending_actions/audit_log (кто предложил / кто подтвердил)
- **Enforced authorization на сервере**: все API-роуты проходят
  `requireOrgAccess(res, orgId)` — нет middle-варианта
- Миграция: существующие данные попадают в организацию `default` (backward-compat)
- Изоляция данных проверяется интеграционными тестами (tenant A не видит tenant B)

## Фаза D — RBAC

Матрица ролей (B2B-минимум):

| Действие | Viewer | Analyst | Media Buyer | Admin |
|---|---|---|---|---|
| Статистика / отчёты | ✅ | ✅ | ✅ | ✅ |
| Аудит | ❌ | ✅ | ✅ | ✅ |
| Рекомендации (просмотр) | ❌ | ✅ | ✅ | ✅ |
| Pause / resume кампании | ❌ | ❌ | ✅ (подтверждение) | ✅ |
| Изменение ставок | ❌ | ❌ | ✅ (подтверждение + лимит) | ✅ |
| Изменение бюджета | ❌ | ❌ | ️ (лимит % от бюджета) | ✅ |
| Подключение/отключение OAuth | ❌ | ❌ | ❌ | ✅ |
| Изменение safety-политики | ❌ | ❌ | ❌ | ✅ |

Реализация: `Role` enum + `can(role, action, resource)` в Policy Engine
(расширение `evaluatePolicy`: на вход добавляется `role` + `orgId`).
Сейчас де-факто роли две: `viewer` (read-only включён) и `admin` (включено) —
это уже отражено в UX («только чтение» по умолчанию + явное включение).

## Фаза E — надёжность execution

- **Retry/backoff** в адаптерах (429/5xx: 3 попытки, exponential, jitter)
- **Background sync worker**: периодический sync production-адаптеров
  (не только по запросу) — отдельный процесс/квест; `last_sync_at` на ad_account
- **Webhook/event-шина**: `actions.applied`, `sync.completed`, `limit.exceeded`
  — для Telegram-уведомлений и интеграций; idempotency-key на каждое событие
- **Structured logging**: pino, request_id сквозной (UI → REST → адаптер → audit)

## Фаза F — интеграции и доказательная база

- Реальный Google Ads (gRPC/GAQL, бюджетные операции на стороне платформы)
- Реальный Авито (партнёрский доступ, ТЗ-13)
- **Integration tests**: testcontainers-postgres + mocked platform APIs
  (запись HTTP → проигрывание), сценарии: полный цикл Директа
- **Security tests**: authz (tenant-изоляция, RBAC), fail-closed auth, rate limit,
  OWASP ASVS Level 1 чек-лист
- **Observability**: metrics (Prometheus format endpoint), alerting на ошибки
  адаптеров и исчерпание лимитов
- **Billing**: metering на LLM-вызовы + actions (основа для pricing)

## Позиционирование (из ревью)

Формулировка для клиентов/инвесторов:

> **AI advertising operations platform** — production-ready architecture,
> Yandex Direct production integration, Google Ads / Avito adapters in sandbox.

Стратегический вектор: **Advertising Control Plane for AI Agents** — MCP/API как
центральный продукт: внешние агенты (Claude/GPT/Gemini) получают доступ к
рекламным действиям через единый execution layer с permissions и guardrails.

## Что сознательно НЕ делаем сейчас

- Новые AI-фичи сверх текущих (advisor, session context)
- Мультитенантность раньше Фазы B (sessions) — иначе двойная миграция
- Реальные Google/Avito до завершения 14-дневного плана по Директу (День 7)
