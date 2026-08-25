# Roadmap

Честный статус и план развития agent-Mr (по состоянию на 25.08.2026).

## Готово и проверено

- **Ядро**: LLM (OpenRouter, tool calling) + детерминированный fallback-парсер;
  session context; 13 команд tool layer.
- **Safety-слой**: read-only по умолчанию, dry-run, лимиты дня/недели/месяца,
  обязательное подтверждение, re-check при подтверждении, audit-log.
- **Production hardening (Phases A–E.1)**:
  - A: fail-closed API auth, Policy Engine, rate limiting, observability;
  - B: session-аутентификация (HttpOnly cookie, CSRF, brute-force lockout);
  - C: multi-tenancy — Postgres RLS (FORCE) на 13 таблицах, tenant-контекст
    transaction-scoped, интеграционные тесты изоляции (17 проверок, 2 орги);
  - C.1: RLS-аудит как регрессионный guard, api-key lifecycle (expiry/revocation);
  - D: RBAC — 5 ролей × 10 действий + риск-слой (капы ставок, бюджетные дельты);
  - E: execution pipeline — write → ответ провайдера → **read-back → VERIFIED**;
    retry на транзиентных ошибках; симулятор Direct API для E2E без денег;
  - E.1: **идемпотентное создание кампаний** (кореляционный тег
    `agentmr:{org}:{action}`, adoption при ретрае), saga-состояние частичного
    сбоя (`createdResources` + `failedAt`) с компенсацией (удаление дерева),
    детерминированный strategy-mapping (preview == provider), money-модуль
    (целочисленные micros, без float в деньгах), fail-closed RBAC
    (неизвестная роль → viewer, не admin).
- **Адаптеры**: Яндекс.Директ — production-ready (OAuth + API v5 + Метрика,
  полный цикл создания кампании с read-back); Google Ads / Авито — sandbox.
- **Клиенты**: Web UI · Telegram-бот · MCP-сервер — один REST API.
- **Качество**: 91 тест (unit + интеграция: RLS-аудит, fail-closed,
  execution pipeline, OAuth security), CI на реальном Postgres,
  production build в CI, демо-видео и статичный демо-сайт.
- **E2E-репетиция**: полный путь «запрос → preview → approve → создание
  (кампания/группа/объявление/ключи) → read-back → VERIFIED → зеркало + audit»
  прогнан вживую против симулятора Direct (нашёл и закрыл 2 бага:
  зеркало с фейковым id, потеря spec'а rule-парсером).

## В работе / ждёт внешних условий

- **Боевой Yandex E2E** — OAuth-токен получен и сохранён, аккаунт в
  production-режиме; **ожидает одобрения заявки на доступ к API Директа**
  (подаётся в кабинете Директа, срок до 7 дней). После одобрения:
  supervised-запуск «AgentMr E2E Test» (300 ₽/день, 1 группа, 1 объявление,
  4 ключа, 2 минус-фразы) с ручным Approve и проверкой по чек-листу
  [`docs/YANDEX_E2E.md`](YANDEX_E2E.md).

## Следующие шаги (в порядке приоритета)

1. **Боевой supervised E2E по Директу** (ждёт заявку) — критерий
   «готово к закрытой beta».
2. **Redis/Upstash rate limiting** (сейчас in-memory per-instance;
   для multi-instance деплоя).
3. **Нормальный OAuth onboarding** (wizard, статусы заявок, device flow).
4. **Биллинг** (metering LLM-вызовов + actions; основа pricing).
5. **Google Ads production** (бюджетные операции на стороне платформы)
   и прод-прогон; **Авито production** (партнёрский доступ).
6. **Multi-customer SaaS**: onboarding новой организации, роли через UI,
   приглашения участников.

## Принципы (не ломаем)

- **R1.** LLM не принимает security decisions — только Policy Engine.
- **R2.** Authentication ≠ Authorization — разные слои.
- **R3.** Re-check политики в момент подтверждения.
- **R4.** Credentials не живут в браузере.
- **R5.** Никаких изменений на площадке без read-back VERIFIED;
  частичные результаты — с явным перечнем созданных объектов.
