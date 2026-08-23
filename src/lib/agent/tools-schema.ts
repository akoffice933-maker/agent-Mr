// JSON-schema definitions of unified tools, given to the LLM for tool calling (ТЗ 7 + этап 1).

import type { LLMTool } from "./llm-client";

const platformsParam = {
  type: "array",
  items: { type: "string", enum: ["google", "yandex", "avito"] },
  description: "Платформы. Не указывай, если пользователь не назвал их явно.",
};

const daysParam = {
  type: "number",
  minimum: 1,
  maximum: 90,
  description: "Период в днях (7 = неделя, 30 = месяц). Не указан — 7.",
};

export const LLM_TOOLS: LLMTool[] = [
  {
    name: "get_spend_report",
    description: "Сводный расход/показы/клики/конверсии по платформам за период.",
    parameters: { type: "object", properties: { days: daysParam, platforms: platformsParam }, additionalProperties: false },
  },
  {
    name: "compare_cpa",
    description: "Сравнение CPA (стоимость конверсии) между площадками + рекомендация по перераспределению бюджета.",
    parameters: { type: "object", properties: { days: daysParam, platforms: { ...platformsParam, description: "Обычно [google, yandex]." } }, additionalProperties: false },
  },
  {
    name: "list_campaigns",
    description: "Список кампаний и объявлений со статистикой.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "active", "paused"], description: "Фильтр по статусу" },
        platform: { type: "string", enum: ["google", "yandex", "avito"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_keyword_performance",
    description: "Статистика по ключевым фразам (топ по расходу).",
    parameters: { type: "object", properties: { days: daysParam, platform: { type: "string", enum: ["google", "yandex"] } }, additionalProperties: false },
  },
  {
    name: "get_avito_chat_summary",
    description: "Сводка по чатам/лидам Авито.",
    parameters: { type: "object", properties: { days: daysParam }, additionalProperties: false },
  },
  {
    name: "run_account_audit",
    description: "Автоматический аудит подключённых кабинетов + создание рекомендаций.",
    parameters: { type: "object", properties: { platforms: platformsParam }, additionalProperties: false },
  },
  {
    name: "pause_low_ctr_campaigns",
    description: "Пауза всех кампаний с CTR ниже порога (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        threshold_pct: { type: "number", description: "Порог CTR в %. Не указан — 1." },
        days: daysParam,
        platforms: platformsParam,
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_campaign_status",
    description: "Пауза/запуск конкретной кампании по названию (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        campaign_name: { type: "string", description: "Название кампании (из контекста диалога или из вопроса пользователя)" },
        status: { type: "string", enum: ["active", "paused"] },
        platform: { type: "string", enum: ["google", "yandex", "avito"], description: "Если название не уникально" },
      },
      required: ["campaign_name", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "adjust_bids",
    description: "Изменение ставок по фильтру (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        percent: { type: "number", description: "На сколько процентов" },
        direction: { type: "string", enum: ["up", "down"] },
        filter: { type: "string", enum: ["all", "with_conversions"], description: "with_conversions — только ключи с конверсиями" },
        platforms: platformsParam,
      },
      required: ["percent", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "create_campaign",
    description: "Создание новой кампании (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        budget: { type: "number", description: "Дневной бюджет, ₽" },
        platform: { type: "string", enum: ["google", "yandex", "avito"], description: "Не указана — google" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "promote_low_view_listings",
    description: "Продвижение объявлений Авито с низким числом просмотров (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: { min_views_per_day: { type: "number", description: "Порог просмотров/день. Не указан — 10." } },
      additionalProperties: false,
    },
  },
  {
    name: "add_negative_keywords",
    description: "Добавление минус-фраз в поисковую кампанию (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        words: { type: "array", items: { type: "string" }, description: "Минус-фразы" },
        platform: { type: "string", enum: ["google", "yandex"] },
      },
      required: ["words"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recommendations",
    description: "Список рекомендаций по оптимизации.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "apply_recommendation",
    description: "Применение рекомендации по id или всех открытых (write-операция, потребует подтверждения).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "id рекомендации" },
        all: { type: "boolean", description: "true — применить все открытые" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "help",
    description: "Справка: что умеет агент и какие команды доступны.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const KNOWN_TOOLS = new Set(LLM_TOOLS.map((t) => t.name));
