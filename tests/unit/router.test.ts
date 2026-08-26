import { describe, expect, it } from "vitest";
import { parseIntent, mergeRuleSpecIntoLlmParams } from "@/lib/agent/router";

describe("parseIntent — rule-based intent parser", () => {
  it("распознаёт сводный расход с периодом", () => {
    const i = parseIntent("Покажи расходы за последние 7 дней");
    expect(i.tool).toBe("get_spend_report");
    expect(i.period.days).toBe(7);
  });

  it("распознаёт период 30 дней", () => {
    const i = parseIntent("Сколько потрачено за 30 дней");
    expect(i.tool).toBe("get_spend_report");
    expect(i.period.days).toBe(30);
  });

  it("сравнивает CPA между двумя площадками", () => {
    const i = parseIntent("Сравни CPA между Google Ads и Яндекс.Директом");
    expect(i.tool).toBe("compare_cpa");
    expect(i.platforms).toEqual(expect.arrayContaining(["google", "yandex"]));
  });

  it("пауза кампаний по CTR с порогом", () => {
    const i = parseIntent("Поставь на паузу кампании с CTR ниже 1.5%");
    expect(i.tool).toBe("pause_low_ctr_campaigns");
    expect(i.params.threshold).toBe(1.5);
  });

  it("пауза конкретной кампании по названию в кавычках", () => {
    const i = parseIntent("Поставь на паузу «Поиск — Диваны на заказ»");
    expect(i.tool).toBe("set_campaign_status");
    expect(i.params.status).toBe("paused");
    expect(String(i.params.name)).toContain("Диваны");
  });

  it("запуск кампании по названию", () => {
    const i = parseIntent("Запусти «YouTube — Имиджевый ролик»");
    expect(i.tool).toBe("set_campaign_status");
    expect(i.params.status).toBe("active");
  });

  it("повышение ставок с фильтром конверсий", () => {
    const i = parseIntent("Подними ставки на 10% по ключам с конверсиями");
    expect(i.tool).toBe("adjust_bids");
    expect(i.params.percent).toBe(10);
    expect(i.params.direction).toBe("up");
    expect(i.params.filter).toBe("with_conversions");
  });

  it("понижение ставок", () => {
    const i = parseIntent("Снизь ставки на 15%");
    expect(i.tool).toBe("adjust_bids");
    expect(i.params.percent).toBe(15);
    expect(i.params.direction).toBe("down");
  });

  it("создание кампании в Директе с бюджетом", () => {
    const i = parseIntent("Создай кампанию в Директе с бюджетом 3000");
    expect(i.tool).toBe("create_campaign");
    expect(i.platforms).toContain("yandex");
    expect(i.params.budget).toBe(3000);
  });

  it("продвижение объявлений Авито", () => {
    const i = parseIntent("Продвинь объявления на Авито с низким количеством просмотров");
    expect(i.tool).toBe("promote_low_view_listings");
    expect(i.platforms).toEqual(["avito"]);
  });

  it("аудит всех кабинетов", () => {
    const i = parseIntent("Сделай аудит всех подключённых кабинетов");
    expect(i.tool).toBe("run_account_audit");
  });

  it("сводка по чатам Авито", () => {
    const i = parseIntent("Сводка по чатам Авито за неделю");
    expect(i.tool).toBe("get_avito_chat_summary");
  });

  it("минус-фразы из кавычек", () => {
    const i = parseIntent("Добавь минус-фразы «б/у, ремонт» в Google");
    expect(i.tool).toBe("add_negative_keywords");
    expect(i.params.words).toEqual(["б/у", "ремонт"]);
    expect(i.platforms).toContain("google");
  });

  it("список рекомендаций", () => {
    const i = parseIntent("Покажи рекомендации");
    expect(i.tool).toBe("list_recommendations");
  });

  it("применение всех рекомендаций", () => {
    const i = parseIntent("Примени все рекомендации");
    expect(i.tool).toBe("apply_recommendation");
    expect(i.params.all).toBe(true);
  });

  it("применение рекомендации по id (винительный падеж)", () => {
    const i = parseIntent("Примени рекомендацию 3");
    expect(i.tool).toBe("apply_recommendation");
    expect(i.params.id).toBe(3);
  });

  it("справка", () => {
    const i = parseIntent("Что ты умеешь?");
    expect(i.tool).toBe("help");
  });

  it("fallback для нераспознанных фраз", () => {
    const i = parseIntent("Привет, как дела?");
    expect(i.tool).toBe("fallback");
  });

  it("определяет площадки по ключевым словам", () => {
    const i = parseIntent("Покажи расходы по гугл за месяц");
    expect(i.platforms).toContain("google");
    expect(i.period.days).toBe(30);
  });
});

describe("create_campaign — full ad-tree spec (E2E runbook grammar)", () => {
  it("парсит полный spec: группа, объявление, ключи, минус-фразы (регистра сохраняется)", () => {
    const i = parseIntent(
      "Создай кампанию в Яндекс Директ под названием «AgentMr E2E Test», бюджет 300/день, " +
        "группа «E2E группа», заголовок «Ремонт квартир под ключ», текст «Быстро, качественно, с гарантией», " +
        "url https://romashka.test/remont, ключи: ремонт квартир, ремонт квартиры под ключ, отделка квартир; " +
        "минус-фразы: бесплатно, работа"
    );
    expect(i.tool).toBe("create_campaign");
    expect(i.platforms).toEqual(["yandex"]);
    expect(i.params.name).toBe("AgentMr E2E Test");
    expect(i.params.budget).toBe(300);
    expect(i.params.adGroupName).toBe("E2E группа");
    expect(i.params.title).toBe("Ремонт квартир под ключ");
    expect(i.params.text).toBe("Быстро, качественно, с гарантией");
    expect(i.params.url).toBe("https://romashka.test/remont");
    expect(i.params.keywords).toEqual(["ремонт квартир", "ремонт квартиры под ключ", "отделка квартир"]);
    expect(i.params.negativeKeywords).toEqual(["бесплатно", "работа"]);
  });

  it("голое создание без маркеров — прежний минимум (никаких догадок)", () => {
    const i = parseIntent("Создай кампанию в Яндекс Директ под названием «Тест», бюджет 500/день");
    expect(i.tool).toBe("create_campaign");
    expect(i.params).toEqual({ name: "Тест", budget: 500 });
  });

  it("только группа — adGroupName без объявления и ключей", () => {
    const i = parseIntent("Создай кампанию «X», бюджет 200/день, группа «Главная»");
    expect(i.tool).toBe("create_campaign");
    expect(i.params.adGroupName).toBe("Главная");
    expect(i.params.title).toBeUndefined();
    expect(i.params.keywords).toBeUndefined();
  });

  it("объявление all-or-nothing: заголовок без текста/URL — не передаётся", () => {
    const i = parseIntent("Создай кампанию «X», бюджет 200/день, заголовок «Только заголовок»");
    expect(i.params.title).toBeUndefined();
    expect(i.params.url).toBeUndefined();
  });

  it("ключи без маркера «ключи:» не подхватываются", () => {
    const i = parseIntent("Создай кампанию «X» по запросу ремонт квартир, бюджет 200/день");
    expect(i.params.keywords).toBeUndefined();
  });

  it("E.2: парсит responsive-объявление — заголовки, уточнения, цена, UTM, изображение", () => {
    const i = parseIntent(
      "Создай кампанию в Яндекс Директ «Кухни», бюджет 500/день, " +
        "заголовки: Кухни под заказ, Кухня мечты от 99 000 ₽, " +
        "текст «Сделаем за 30 дней», url https://example.com, " +
        "уточнения: Свой дизайн, Гарантия 5 лет, " +
        "цена от 99000, старая цена 149000, " +
        "utm: utm_source=agentmr&utm_medium=cpc, " +
        "изображение: https://cdn.example.com/k.png"
    );
    expect(i.tool).toBe("create_campaign");
    expect(i.params.titles).toEqual(["Кухни под заказ", "Кухня мечты от 99 000 ₽"]);
    expect(i.params.title).toBe("Кухни под заказ");
    expect(i.params.text).toBe("Сделаем за 30 дней");
    expect(i.params.url).toBe("https://example.com");
    expect(i.params.callouts).toEqual(["Свой дизайн", "Гарантия 5 лет"]);
    expect(i.params.priceRubles).toBe(99000);
    expect(i.params.priceQualifier).toBe("from");
    expect(i.params.priceOldRubles).toBe(149000);
    expect(i.params.trackingParams).toBe("utm_source=agentmr&utm_medium=cpc");
    expect(i.params.images).toEqual([{ url: "https://cdn.example.com/k.png" }]);
  });

  it("E.2: «цена до» → up_to; без квалификатора — plain price", () => {
    const i1 = parseIntent("Создай кампанию «X», бюджет 200/день, заголовок «T», текст «D», url https://e.com, цена до 500");
    expect(i1.params.priceRubles).toBe(500);
    expect(i1.params.priceQualifier).toBe("up_to");
    const i2 = parseIntent("Создай кампанию «X», бюджет 200/день, заголовок «T», текст «D», url https://e.com, цена 1200");
    expect(i2.params.priceRubles).toBe(1200);
    expect(i2.params.priceQualifier).toBeUndefined();
  });

  it("E.2: «старая цена» не считается новой ценой", () => {
    const i = parseIntent("Создай кампанию «X», бюджет 200/день, заголовок «T», текст «D», url https://e.com, старая цена 999");
    expect(i.params.priceOldRubles).toBe(999);
    expect(i.params.priceRubles).toBeUndefined();
  });

  it("E.2: слово «Запуск» внутри заголовка НЕ крадёт интент у create_campaign (bug 4b)", () => {
    const i = parseIntent(
      "Создай кампанию «X», бюджет 300/день, заголовки: Запуск кампаний в один чат, H2, " +
        "текст «Текст», url https://e.com"
    );
    expect(i.tool).toBe("create_campaign");
    expect(i.params.titles).toEqual(["Запуск кампаний в один чат", "H2"]);
    // без маркера создания — старое поведение сохранено
    const i2 = parseIntent("Запусти «Хлеб и соль»");
    expect(i2.tool).toBe("set_campaign_status");
    expect(i2.params.status).toBe("active");
  });

  it("E.2: merge — явный spec в тексте дополняет неполные LLM-параметры", () => {
    const text =
      "Создай кампанию в Яндекс Директ «agent-Mr», бюджет 3333/день, " +
      "заголовки: H1, H2, текст «Текст объявления», url https://agent-mr.example/, " +
      "уточнения: Уточ 1, Уточ 2, utm: utm_source=agentmr, изображение: https://cdn.example.com/a.jpg";
    // LLM passed only name/budget/title (small-model drop)
    const llmParams = { name: "agent-Mr", budget: 3333, title: "H1" };
    const merged = mergeRuleSpecIntoLlmParams(llmParams, text);
    expect(merged.titles).toEqual(["H1", "H2"]);
    expect(merged.text).toBe("Текст объявления");
    expect(merged.url).toBe("https://agent-mr.example/");
    expect(merged.callouts).toEqual(["Уточ 1", "Уточ 2"]);
    expect(merged.trackingParams).toBe("utm_source=agentmr");
    expect(merged.images).toEqual([{ url: "https://cdn.example.com/a.jpg" }]);
    // non-create_campaign tool: untouched
    const other = mergeRuleSpecIntoLlmParams({ days: 7 }, "расход за 7 дней");
    expect(other).toEqual({ days: 7 });
  });

  it("«минус-фразы» БЕЗ создания кампаний — прежний инструмент add_negative_keywords (регрессия)", () => {
    const i = parseIntent("Добавь минус-фразы «бесплатно», «работа» в кампанию «Поиск — Кухни»");
    expect(i.tool).toBe("add_negative_keywords");
    expect(i.params.words).toContain("бесплатно");
  });
});
