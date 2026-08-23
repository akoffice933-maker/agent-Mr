import { describe, expect, it } from "vitest";
import { parseIntent } from "@/lib/agent/router";

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
