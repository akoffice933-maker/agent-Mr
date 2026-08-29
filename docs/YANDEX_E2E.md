# Реальный Yandex E2E — runbook первого боевого запуска

Цель (по ревью 25.08.2026): **одна контролируемая кампания** в настоящем
Yandex Direct:

```
Название: AgentMr E2E Test
Бюджет: минимальный (300 ₽/день)
1 группа · 1 объявление · 3–5 ключей · 1–2 минус-слова
Preview → ручной Approve → Execute → Read-back → VERIFIED
```

Автономные изменения бюджета/ставок — **НЕ включаем** (supervised beta:
каждое изменение проходит preview + ручной approve; рекомендации по бюджету/
ставкам отклонять до завершения E2E).

## 1. Что уже доказано (песочница, 25.08.2026)

Полный путь отработал против симулятора Direct c тем же контрактом API:

- `/api/agent/chat` → rule/LLM intent → **preview** (cost, стратегия,
  `pendingActionId`)
- `/api/agent/action {decision: "approve"}` → `resolvePending` →
  `planEffect` → `executeAdapters`
- `campaign-builder`: campaign → adgroup → ad → keywords с **кореляционным
  тегом** `agentmr:{org}:{actionId}` (идемпотентность ретраев)
- **Read-back**: реальные Id у провайдера, `pending_actions.status = verified`,
  `readback.createdResources[]` (saga-состояние), mirror-строка с **реальным**
  external_id, audit-log (`pending → verified`)
- Полный spec (группа + объявление + 4 ключа + 2 минус-слова) — VERIFIED

Единственное, что не доказано: **реальный** `api.direct.yandex.com`
(контракт симулятора сверен с официальной документацией Direct API v5, но
боевой прогон — следующий шаг).

## 2. Подготовка (разово)

### 2.1 OAuth-приложение Yandex ID
1. https://oauth.yandex.ru/manage/ → «Создать приложение» (Web application).
2. Scope: `direct` (Yandex Direct API).
3. Redirect URI: **публичный URL песочницы/деплоя**, например
   `https://<sandbox>/api/oauth/yandex` (в песочнице host меняется между
   сессиями — регистрируйте URI текущего хоста; при деплое — постоянный).
4. Записать `client_id` / `client_secret`.

### 2.2 Переменные окружения (сервера приложения)
```
YANDEX_OAUTH_CLIENT_ID=...
YANDEX_OAUTH_CLIENT_SECRET=...
PUBLIC_URL=https://<host>          # origin для redirect
# ENCRYPTION_KEY уже обязателен (шифрование токенов, src/lib/crypto)
```

### 2.3 Подключение аккаунта
В UI: /safety → «Подключить Яндекс.Директ» (или `/api/oauth/yandex?start=1`).
После callback: `oauth_tokens` заполнен, `accounts.mode = production`,
автосинк кампании в локальное зеркало.

Проверка: в UI видны реальные кампании аккаунта (sync) — если да, адаптер
говорит с живым Direct.

## 3. Supervised-профиль (перед первым запуском)

В настройках безопасности (страница /safety или `settings` в БД, org=1):

| настройка | значение | зачем |
|---|---|---|
| `dry_run` | **false** | исполнять approved-действия |
| `read_only` | **false** | разрешить writes (explicit opt-in) |
| подтверждение бюджета | всегда | жёсткое правило: любые бюджетные изменения — только с подтверждением (не настройка) |
| лимиты день/неделя/месяц | 50000 / 250000 / 900000 | уже по умолчанию |

Правила оператора на время E2E:
- **approve** — только `create_campaign` «AgentMr E2E Test» (п. 4);
- **reject** — любые рекомендации/изменения ставок, бюджетов, пауз, пока E2E
  не завершён (интерфейс это позволяет: каждое действие — отдельный pending);
- автономного исполнения в архитектуре нет: **никакое** write-действие не
  применяется без `decision: "approve"` конкретного человека.

## 4. Сам E2E-запуск

Сообщение агенту (или UI):

> Создай кампанию в Яндекс Директ под названием «AgentMr E2E Test», бюджет
> 300/день, группа «E2E группа», объявление: заголовок «Ремонт квартир под
> ключ», текст «Быстро, качественно, с гарантией», url
> https://<ваш-сайт>, ключи: ремонт квартир, ремонт квартиры под ключ, отделка
> квартир; минус-фразы: бесплатно, работа

(Полный набор параметров заполняет LLM-путь; rule-based fallback создаст
кампанию без дерева объявлений — для боевого E2E нужен LLM-ключ.)

Ожидаемый preview: кампания + стратегия «Максимум кликов» + 4 ключа,
cost ≈ 300 ₽/день, `pendingActionId`.

**Ручной Approve.** Затем контрольный список (см. п. 5).

### Ретрай-сценарий (проверка идемпотентности, опционально)
Если первый execute прервался (таймаут/5xx) — `pending_actions.status =
failed`, `readback.createdResources[]` показывает, что уже создано. Повторный
approve **должен** продолжить: в Direct ищется кампания по тегу
`agentmr:1:<actionId>` и усыновляется — **без дубля**. Проверить в UI Директа:
ровно одна кампания с этим тегом.

### Compensation-сценарий (опционально)
После E2E удалить кампанию через агента: «Удали созданную кампанию AgentMr
E2E Test» → preview → approve → `delete_campaign_tree` (ads → keywords →
adgroups → campaign) → read-back пуст → VERIFIED.

## 5. Проверка результата (обязательный чек-лист)

### 5.1 В Yandex Direct (руками)
- [ ] Кампания «AgentMr E2E Test · agentmr:1:N» существует, State ON
- [ ] 1 группа «E2E группа», регион [0] (все), минус-слова «бесплатно», «работа»
- [ ] 1 текстовое объявление: заголовок/текст/URL как в запросе
- [ ] 4 ключевые фразы
- [ ] WeeklySpendLimit = 300 × 7 × 1e6 micros (WbMaximumClicks)

### 5.2 В БД (org 1)
- [ ] `pending_actions`: `status = verified`, `attempts = 1`
- [ ] `pending_actions.readback->yandex->createdResources` — 6 ресурсов с
      реальными Id (campaign, adgroup, ad, 4×keyword)
- [ ] `campaigns`: ровно 1 строка, `external_id` = реальный Id кампании,
      `strategy = 'maximum_clicks'`
- [ ] `audit_log`: `create_campaign` (pending) + `create_campaign` (verified)
- [ ] `oauth_tokens`: токен аккаунта зашифрован (не plain text)

### 5.3 В UI
- [ ] Кампания видна в /campaigns с реальными данными
- [ ] Агент подтвердил: «…подтверждено read-back (id <реальный>)»

## 6. Если что-то пошло не так

| симптом | где смотреть |
|---|---|
| 401 от token endpoint | client_id/secret, redirect URI в Yandex ID |
| синк не видит кампании | scope `direct` в OAuth-приложении |
| `read-back mismatch` | контракт ответа vs симулятор: сверить `lastRequests` |
| дубль кампании при ретрае | тег `agentmr:` в именах; `createdResources` |
| `Direct: … 270 … not found` | Id из чужого аккаунта/орга — проверить org в pending |

## 7. Критерий «готово» (из ревью)

Все пункты 5.1–5.3 зелёные → **agent-Mr готов к закрытой supervised beta**:
AI создаёт → Preview → человек проверяет → Approve → Yandex → Read-back →
VERIFIED → Audit. Автономное изменение бюджета/ставок — после beta.
