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
