# Closed supervised beta — runbook оператора

> Для пилотных агентств на Яндекс.Директе. Google Ads / Авито — sandbox до Phase 2.

## 1. Кому подходит beta

- Агентство или in-house команда с **1–3 кабинетами Директа**
- Готовность **вручную подтверждать** каждое write-действие 1–2 недели
- Бюджет на тест: от 300 ₽/день на одну тестовую кампанию

## 2. Что уже безопасно

| Гарантия | Как |
|----------|-----|
| LLM не пишет в API | только Policy Engine + adapters |
| Read-only по умолчанию | явный opt-in на /safety |
| Каждый write → preview → human approve | pending_actions |
| Re-check лимитов при approve | policy снова |
| Read-back VERIFIED | иначе status=failed, зеркало не трогаем |
| Идемпотентный retry | correlation tag `agentmr:{org}:{actionId}` |
| Multi-tenant isolation | Postgres RLS FORCE |
| Pending TTL 48 ч | auto expired |
| Cap 20 open pending / org | отказ новых writes |

## 3. Онбординг пилота (чеклист)

### Платформа
- [ ] OAuth-приложение Яндекса + **одобренная** заявка API в кабинете Директа
- [ ] `YANDEX_OAUTH_*`, `ENCRYPTION_KEY`, `PUBLIC_URL` в `.env`
- [ ] Подключение кабинета: /safety → Площадки → Яндекс.Директ
- [ ] «Покажи расходы за 7 дней» совпадает с кабинетом

### Безопасность
- [ ] `read_only=false`, `dry_run=false` только после обучения оператора
- [ ] `confirm_budget=true`
- [ ] Роли: media_buyer для байеров, admin — 1–2 человека
- [ ] REDIS_URL в проде (если >1 инстанс)

### Первый supervised прогон
- [ ] Кампания «AgentMr E2E Test», 300 ₽/день (см. `docs/YANDEX_E2E.md`)
- [ ] Все пункты 5.1–5.3 чек-листа зелёные
- [ ] Ретрай и compensation (опционально) пройдены

## 4. Правила оператора на beta

1. **Approve** только действия, которые вы реально хотите применить.
2. Любые рекомендации по ставкам/бюджету с дельтой >10% — **сначала глазами**, потом approve.
3. При `status=failed` и частичном создании — либо **повторный approve** (resume), либо «удали созданную кампанию».
4. Не отключать read-only на проде без согласования.
5. Инцидент (неожиданная кампания / расход) → reject remaining pending → /safety read-only → написать в канал поддержки.

## 5. Что ещё не в beta

- Автономные изменения бюджета/ставок без approve
- Google Ads create_campaign (platform write — Phase 2)
- Авито: партнёрский доступ и строгий status read-back (патч Phase 2)
- Биллинг / self-serve signup

## 6. Метрики успеха пилота (14 дней)

- 0 неконтролируемых write на площадке
- ≥50% рутинных пауз/минусов через агента
- Время на недельный отчёт ↓ ≥2×
- NPS операторов ≥40

## 7. Контакты

- Репозиторий: https://github.com/akoffice933-maker/agent-Mr
- Документы: `docs/YANDEX_SETUP.md`, `docs/YANDEX_E2E.md`, `docs/USAGE.md`, `docs/HARDENING.md`
