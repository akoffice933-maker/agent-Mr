# Вклад в agent-Mr

Спасибо за интерес! Проект развивается по [ROADMAP.md](docs/ROADMAP.md).

## Подготовка окружения

```bash
git clone https://github.com/akoffice933-maker/agent-Mr.git && cd agent-Mr
npm install
# Postgres 14+ (см. docs/SETUP.md), затем:
npm run migrate
npm run seed
npm run dev
```

## Проверки перед пушем

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # vitest: unit + интеграция (нужна БД: DATABASE_TEST_URL)
npm run build       # production-сборка
```

Интеграционные тесты (`tests/integration/`, `tests/execution-pipeline.test.ts`)
работают против настоящей PostgreSQL: задайте `DATABASE_TEST_URL`
(по умолчанию — `postgresql://appuser:apppass@127.0.0.1:5432/app_db`).

## Принципы кода (не нарушать)

- **R1.** LLM не принимает security decisions — только Policy Engine
  (`src/lib/agent/policy.ts`).
- Tenant-данные — только через `db` (tenant-bound, RLS); identity-плоскость —
  только через `identityPool`.
- Деньги — только через `src/lib/money.ts` (целочисленные micros).
- Все write-операции адаптеров — с read-back верификацией; локальное зеркало
  меняется только после VERIFIED.
- Тесты — живые: интеграционные сценарии против реальной БД и симулятора
  Direct API, а не моки поведения.

## Коммиты

Описательные, по-русски или по-английски, в стиле существующих:
`fix(yandex-api): …`, `feat(agent): …`, `test(rbac): …`.
