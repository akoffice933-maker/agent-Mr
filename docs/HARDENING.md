# Production Hardening v1 — roadmap

Документ превращает внешнее ревью (авг 2026) в план работ. Главный принцип:
**не 20 новых AI-фич, а production-готовность execution layer**.

Критерий «production-ready»: системе можно доверить рекламные бюджеты первого
реального клиента без риска неконтролируемых действий.

## Архитектурные правила (не нарушать)

**R1. LLM не имеет права принимать security decisions.**
LLM может решить: «я хочу изменить bid на 15%» (structured intent).
LLM никогда не решает: «это безопасно, можно выполнять». Решение о допуске
принимает только код — Policy Engine (`src/lib/agent/policy.ts`). Это правило
проверяется на ревью: любой путь, где ответ LLM напрямую управляет исполнением
без `evaluatePolicy()`, — дефект.

**R2. Разделение уровней (не смешивать authentication и authorization).**

```
Authentication    «кто ты?»             session cookie / x-api-key
     ↓
Tenant resolution «какая организация?»  (Фаза C: organization_id)
     ↓
Authorization     «имеешь ли право?»    (Фаза D: RBAC + ownership)
     ↓
Policy            «разрешено ли действие?» (policy.ts: allow / approval / block)
     ↓
Execution         «можно ли выполнить сейчас?» (adapters, re-check policy)
```

**R3. Re-check перед execution.** Состояние может измениться между approval и
execution (другой оператор, исчерпанный лимит) — политика оценивается повторно
непосредственно перед применением (`resolvePending` → `evaluatePolicy` again).

**R4. Credentials не живут в браузере.** Только HttpOnly/SameSite=Strict cookie
с session id. Никаких ключей и паролей в localStorage / JS-бандле.

## Фаза A — обязательный периметр (выполняется первой)

| # | Задача | Статус |
|---|---|---|
| A1 | **Mandatory API auth**: в production-режиме (`NODE_ENV=production` или `AGENT_MODE=production`) без `AGENT_API_KEY` API **недоступен** (503 fail-closed), а не открыт. Dev остаётся без трения. | ✅ `src/lib/auth-policy.ts` + `src/proxy.ts` |
| A2 | **Policy Engine** — выделенный детерминированный слой: `allow / require_approval / block`. LLM/парсер только формируют structured intent, решения о допуске принимает `evaluatePolicy()`. Одна и та же оценка — до выполнения и повторно при подтверждении. | ✅ `src/lib/agent/policy.ts` + 6 unit-тестов |
| A3 | **Rate limiting** по IP: read 120 req/min, write 20 req/min, 429 + Retry-After. In-memory (single instance); для multi-instance — вынести в Redis. | ✅ `src/proxy.ts` |
| A4 | **Idempotency** действий: повторный approve/reject того же pending-действия безопасен (проверка статуса, «уже обработано»). Явная Idempotency-Key шапка — фаза B. | ✅ (существующая механика `pending_actions.status`) |
| A5 | **Observability-база**: `/api/health` возвращает db, mode, auth, uptime. Структурные логи — фаза B. | ✅ |

## Фаза B — session-аутентификация ✅ (выполнена)

Задача: убрать credentials из браузера (XSS → ключ → действия с бюджетами) и
заложить identity (`User └── Sessions`) под multi-tenancy.

Реализация:

1. **Схема**: `users` (email, scrypt-хеш, `role` — заготовка под Фазу D) +
   `sessions` (id, user_id FK cascade, ip, ua, 12h sliding expiry, revoked_at).
   Миграция `0002_users_sessions`.
2. **Login**: `POST /api/auth/login` → HttpOnly **Secure** SameSite=Strict cookie
   `agentmr_sid` (Secure включается автоматически при `PUBLIC_URL=https://…`).
   Ротация: каждый login — новый session id; sliding-expiry на активность.
   Timing-equalized verify: dummy scrypt при неизвестном email (не раскрывает
   существование учётки по времени ответа).
3. **CSRF**: SameSite=Strict + обязательный заголовок `X-Agent-Csrf` на mутациях
   с session-auth (проверяется прокси; machine-клиенты на `x-api-key` не
   зависят от CSRF — у них нет cookie).
4. **Brute-force**: 10 login/min на IP (прокси) + lockout 5 неудач → 15 минут
   (in-memory; при multi-instance — в общий стор).
5. **Logout/revocation**: `POST /api/auth/logout` (revoke), `revokeAllForUser`
   (доступно для смены пароля / админ-действия).
6. **Машиные клиенты**: MCP/Telegram — без изменений, `x-api-key` (M2M).
   Идентификация MCP-вызовов до уровня организации — Фаза C.
7. **Режимы**: `AGENT_AUTH_MODE=off` (дефолт: sandbox/dev без трения) / `on`
   (SaaS). Fail-closed сохранён: auth-on + нет `AGENT_API_KEY` + нет users → 503.
8. **UI**: страница `/login`, AuthGuard (редирект `/login?next=…`), UserMenu в
   сайдбаре (email + logout). `localStorage` в клиенте больше не используется.
9. **CLI**: `npm run create-user -- <email> <password> [name]`.
10. **E2E-покрыто**: 503 без users; 401 неверный пароль; 200 + cookie;
    403 мутация без CSRF; 401 без сессии; machine-key 200/401; logout → replay
    сессии 401; lockout 429 после 5 неудач; UI-логин с редиректом на next.

## Фаза C — Tenant Isolation Phase ✅ (выполнена)

> Фаза сознательно сделана не «миграцией таблиц», а доказательством того, что
> tenant isolation невозможно случайно обойти. Инвариант проекта:
> **Knowledge of another org's id (campaign/action/uuid) never grants access.**

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

Реализация:

1. **Схема** (`0003` + `0004`): `organizations`, `org_members` (unique org+user, role),
   `api_keys` (org-scoped machine keys, sha256 hash). `organization_id NOT NULL` + FK на
   accounts, campaigns, pending_actions, audit_log, recommendations, chat_messages,
   settings, oauth_tokens. Производные таблицы (metrics/keywords/negatives/chats)
   изолируются через FK на campaigns.
2. **RLS (FORCE) в Postgres** — изоляция на уровне базы: политика
   `organization_id = tenant_org_id()`, где `tenant_org_id()` читает `app.org_id`
   (NULL при отсутствии → 0 строк). Identity-плоскость (organizations, org_members,
   api_keys, users, sessions) намеренно вне RLS — прокси резолвит контекст из неё.
3. **Tenant context**: `session → user → org membership` (первичная организация),
   устанавливается ТОЛЬКО в прокси внутренними заголовками `x-tenant-*`
   (клиентские копии стираются). Из тела запроса org не берётся никогда.
4. **Пул с закреплённым контекстом** (`src/lib/tenant/pool.ts`): `withTenant()`
   пиннит ОДНО соединение на запрос, `SET app.org_id` на нём, все drizzle-запросы
   маршрутизируются туда. Fail-closed: без контекста — 0 строк (баг теряет данные,
   но не утекает).
5. **Pending actions**: выборка `WHERE id AND organization_id = caller AND status='pending'`,
   guarded-UPDATE с тем же условием; cross-tenant → 404 (без утечки существования);
   re-check перед execution (R3).
6. **OAuth**: `state` привязан к user+org инициировавшего; callback сверяет завершающую
   сессию с state; токен и sync выполняются в tenant-контексте организации.
7. **Machine keys**: `api_keys` (org-scoped, `amr_…`), MCP/Telegram получают org
   из ключа; legacy env `AGENT_API_KEY` → default org. `npm run create-api-key`.
8. **Доказательство** (E2E, 17/17): A не видит кампании B; B не видит кампании A;
   approve чужого action → 404; pending-list изолирован; machine keys scoped;
   CSRF/401/lockout не пострадал; RLS fail-closed проверен на уровне БД.

Definition of Done — закрыто:

- [x] organizations, org_members
- [x] organization_id everywhere required (NOT NULL after migration)
- [x] FK constraints + tenant indexes
- [x] tenant context (session → user → membership)
- [x] centralized tenant authorization (прокси + RLS)
- [x] API isolation tests (E2E 2-org)
- [x] service-layer isolation tests (pending guarded, RLS raw)
- [x] MCP isolation tests (org-scoped keys, wrong key 401)
- [x] pending-action isolation (404 cross-tenant, double-approve 404)
- [x] OAuth isolation (state vs session, tenant-bound token storage)
- [x] audit isolation (org-scoped audit_log, RLS)
- [x] default-org migration (0004 backfill → NOT NULL)
- [x] no client-supplied tenant trust (внутренние заголовки, стирание клиентских)
- [x] CI green

Операционное: миграции/сид выполняются привилегированным пользователем БД
(BYPASSRLS, напр. `dbowner`), приложение — под `appuser` (подчиняется RLS).

## Фаза D — RBAC

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
