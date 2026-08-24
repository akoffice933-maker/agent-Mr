import "dotenv/config";
import { db } from "./index";
import {
  accounts,
  auditLog,
  campaigns,
  chats,
  keywords,
  messages,
  metricsDaily,
  negativeKeywords,
  organizations,
  recommendations,
  settings,
} from "./schema";

const ORG = 1; // default organization (seed runs as the privileged role)

// deterministic RNG
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260823);
const rf = (min: number, max: number) => min + rnd() * (max - min);
const ri = (min: number, max: number) => Math.round(rf(min, max));

function dateBack(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

interface CampSpec {
  platform: "google" | "yandex" | "avito";
  kind: "campaign" | "listing";
  name: string;
  status?: string;
  budget: number;
  strategy: string;
  price?: number;
  promotion?: string;
  // metric model
  spend: [number, number]; // daily spend range
  cpc: [number, number];
  ctr: number; // fraction
  cvr: number; // fraction of clicks → conversions
  views?: [number, number]; // avito daily views override
}

const GOOGLE: CampSpec[] = [
  { platform: "google", kind: "campaign", name: "Поиск — Диваны на заказ", budget: 3500, strategy: "Ручные ставки (CPC)", spend: [2400, 3300], cpc: [38, 52], ctr: 0.046, cvr: 0.055 },
  { platform: "google", kind: "campaign", name: "Поиск — Кухни под заказ Москва", budget: 3000, strategy: "Максимум конверсий", spend: [2100, 2900], cpc: [42, 58], ctr: 0.039, cvr: 0.048 },
  { platform: "google", kind: "campaign", name: "Performance Max — Мебель для дома", budget: 5000, strategy: "Целевая CPA (1 900 ₽)", spend: [3600, 4800], cpc: [22, 34], ctr: 0.031, cvr: 0.042 },
  { platform: "google", kind: "campaign", name: "Display — Ретаргетинг каталога", budget: 1200, strategy: "Ретаргетинг 30 дней", spend: [700, 1100], cpc: [9, 15], ctr: 0.009, cvr: 0.018 },
  { platform: "google", kind: "campaign", name: "Shopping — Каталог товаров", status: "paused", budget: 2000, strategy: "Макс. клики", spend: [1400, 1900], cpc: [12, 18], ctr: 0.021, cvr: 0.03 },
  { platform: "google", kind: "campaign", name: "YouTube — Имиджевый ролик", budget: 900, strategy: "Охват", spend: [500, 850], cpc: [6, 10], ctr: 0.0035, cvr: 0.002 },
];

const YANDEX: CampSpec[] = [
  { platform: "yandex", kind: "campaign", name: "Поиск — диваны москва купить", budget: 3200, strategy: "Ручное управление ставками", spend: [2300, 3100], cpc: [34, 48], ctr: 0.051, cvr: 0.062 },
  { platform: "yandex", kind: "campaign", name: "Поиск — кухни на заказ", budget: 2800, strategy: "Оптимизация конверсий", spend: [2000, 2700], cpc: [38, 52], ctr: 0.043, cvr: 0.054 },
  { platform: "yandex", kind: "campaign", name: "РСЯ — Ретаргетинг", budget: 1500, strategy: "Ретаргетинг 30 дней", spend: [900, 1400], cpc: [11, 17], ctr: 0.012, cvr: 0.024 },
  { platform: "yandex", kind: "campaign", name: "Смарт-баннеры — Каталог", budget: 1100, strategy: "Автотаргетинг", spend: [650, 1050], cpc: [8, 13], ctr: 0.018, cvr: 0.026 },
  { platform: "yandex", kind: "campaign", name: "Мастер кампаний — Акция −20%", status: "paused", budget: 1000, strategy: "Максимум конверсий", spend: [700, 980], cpc: [15, 22], ctr: 0.028, cvr: 0.038 },
  { platform: "yandex", kind: "campaign", name: "Товарная кампания — Фильтр", budget: 1800, strategy: "Автостратегия", spend: [1100, 1700], cpc: [10, 16], ctr: 0.006, cvr: 0.012 },
];

const AVITO: CampSpec[] = [
  { platform: "avito", kind: "listing", name: "Диван-кровать «Осло»", budget: 300, strategy: "CPA за контакт", price: 89900, spend: [180, 300], cpc: [1, 1], ctr: 0, cvr: 0, views: [38, 70] },
  { platform: "avito", kind: "listing", name: "Кухонный гарнитур «Лофт», 3 м", budget: 300, strategy: "CPA за контакт", price: 145000, spend: [150, 280], cpc: [1, 1], ctr: 0, cvr: 0, views: [30, 55] },
  { platform: "avito", kind: "listing", name: "Шкаф-купе с зеркалом", budget: 200, strategy: "Тариф «Базовый»", price: 42500, spend: [90, 180], cpc: [1, 1], ctr: 0, cvr: 0, views: [22, 40] },
  { platform: "avito", kind: "listing", name: "Кровать 160×200 с подъёмным механизмом", budget: 150, strategy: "Тариф «Базовый»", price: 54900, spend: [0, 60], cpc: [1, 1], ctr: 0, cvr: 0, views: [3, 7] },
  { platform: "avito", kind: "listing", name: "Комод «Скандинавия»", budget: 100, strategy: "Тариф «Базовый»", price: 18900, spend: [0, 40], cpc: [1, 1], ctr: 0, cvr: 0, views: [2, 6] },
  { platform: "avito", kind: "listing", name: "Офисное кресло ErgoLine", budget: 200, strategy: "Продвижение «Турбо»", promotion: "turbo", price: 24900, spend: [140, 220], cpc: [1, 1], ctr: 0, cvr: 0, views: [45, 80] },
  { platform: "avito", kind: "listing", name: "Стол обеденный раздвижной", budget: 150, strategy: "Тариф «Базовый»", price: 36700, spend: [0, 50], cpc: [1, 1], ctr: 0, cvr: 0, views: [4, 9] },
  { platform: "avito", kind: "listing", name: "Детская кровать-чердак", budget: 200, strategy: "Тариф «Расширенный»", price: 29900, spend: [80, 160], cpc: [1, 1], ctr: 0, cvr: 0, views: [18, 34] },
];

async function main() {
  const org = (await db.select().from(organizations).limit(1))[0];
  if (!org) {
    await db.insert(organizations).values({ name: "Default" });
    console.log("→ Организация Default создана (id 1)");
  }
  console.log("→ Очистка таблиц...");
  await db.delete(messages);
  await db.delete(recommendations);
  await db.delete(pendingActionsTable());
  await db.delete(auditLog);
  await db.delete(negativeKeywords);
  await db.delete(keywords);
  await db.delete(chats);
  await db.delete(metricsDaily);
  await db.delete(campaigns);
  await db.delete(accounts);
  await db.delete(settings);

  console.log("→ Аккаунты...");
  const accGoogle = (await db.insert(accounts).values({ organizationId: ORG, platform: "google", name: "Google Ads · ООО «Ромашка Мебель»", login: "781-234-5690", mode: "sandbox" }).returning())[0];
  const accYandex = (await db.insert(accounts).values({ organizationId: ORG, platform: "yandex", name: "Яндекс.Директ · romashka-mebel", login: "kozharina@romashka.ru", mode: "sandbox" }).returning())[0];
  const accAvito = (await db.insert(accounts).values({ organizationId: ORG, platform: "avito", name: "Авито · Ромашка Мебель (Москва)", login: "romashka_mebel_msk", mode: "sandbox" }).returning())[0];

  const all = [...GOOGLE, ...YANDEX, ...AVITO];
  const campIds: Record<string, number> = {};
  const metricRows: (typeof metricsDaily.$inferInsert)[] = [];

  console.log("→ Кампании и метрики (28 дней)...");
  for (let i = 0; i < all.length; i++) {
    const spec = all[i];
    const accId = spec.platform === "google" ? accGoogle.id : spec.platform === "yandex" ? accYandex.id : accAvito.id;
    const inserted = (
      await db.insert(campaigns).values({
        organizationId: ORG,
        accountId: accId,
        platform: spec.platform,
        kind: spec.kind,
        externalId: spec.platform === "yandex" ? String(10000 + i * 37) : `${spec.platform === "google" ? "gads" : "avt"}-${10000 + i * 37}`,
        name: spec.name,
        status: spec.status ?? "active",
        budgetDaily: spec.budget,
        strategy: spec.strategy,
        price: spec.price ?? null,
        promotion: spec.promotion ?? "none",
      }).returning()
    )[0];
    campIds[spec.name] = inserted.id;

    for (let d = 27; d >= 0; d--) {
      const date = dateBack(d);
      // paused campaigns stopped spending ~10 days ago
      if (spec.status === "paused" && d < 10) continue;
      const k = d === 0 ? 0.62 : 1; // today is partial
      let spend = rf(spec.spend[0], spec.spend[1]) * k;
      let impressions = 0;
      let clicks = 0;
      let conversions = 0;
      if (spec.kind === "listing") {
        impressions = ri(spec.views![0], spec.views![1]);
        clicks = Math.max(0, Math.round(impressions * rf(0.03, 0.07)));
        conversions = Math.random() < 0 ? 0 : Math.round(clicks * rf(0.3, 0.55));
        spend = Math.min(spend, clicks * 45 + impressions * 1.2);
      } else {
        const cpc = rf(spec.cpc[0], spec.cpc[1]);
        clicks = Math.round(spend / cpc);
        impressions = Math.round(clicks / Math.max(spec.ctr, 0.0001));
        conversions = Math.round(clicks * spec.cvr * rf(0.7, 1.3));
      }
      metricRows.push({
        campaignId: inserted.id,
        date,
        spend: Math.round(spend * 100) / 100,
        impressions,
        clicks,
        conversions,
      });
    }
  }
  await db.insert(metricsDaily).values(metricRows);

  console.log("→ Ключевые фразы...");
  const kwData: { camp: string; words: [string, number, number][] }[] = [
    {
      camp: "Поиск — Диваны на заказ",
      words: [
        ["диван на заказ москва", 62, 12], ["диван угловой на заказ", 54, 8], ["купить диван от производителя", 47, 9],
        ["диван кровать на заказ цена", 58, 6], ["изготовление диванов под заказ", 51, 5], ["диван еврокнижка на заказ", 44, 4],
        ["диван б у купить", 21, 0], ["авито диваны", 18, 0], ["диван п образный на заказ", 49, 3],
        ["обивка дивана на дому", 26, 0], ["недорогой диван на заказ", 42, 7], ["диван с реканье на заказ", 55, 2],
      ],
    },
    {
      camp: "Поиск — Кухни под заказ Москва",
      words: [
        ["кухня под заказ москва", 68, 10], ["кухонный гарнитур на заказ цена", 61, 7], ["заказать кухню от производителя", 57, 6],
        ["кухня лофт на заказ", 52, 4], ["маленькая кухня на заказ", 48, 3], ["кухня угловая на заказ москва", 64, 8],
        ["кухни бу", 19, 0], ["расчет кухни онлайн", 33, 1], ["кухня из массива на заказ", 59, 5], ["фасады для кухни купить", 37, 1],
      ],
    },
    {
      camp: "Поиск — диваны москва купить",
      words: [
        ["диваны москва купить", 56, 13], ["купить угловой диван в москве", 49, 9], ["диван от производителя москва", 45, 8],
        ["купить диван кровать недорого", 41, 6], ["диван аккордеон купить", 39, 5], ["магазин диванов москва", 43, 4],
        ["диван даром", 17, 0], ["купить диван с доставкой сегодня", 36, 3], ["недорогие диваны москва каталог", 38, 7], ["диван клик кляк купить", 35, 2],
      ],
    },
    {
      camp: "Поиск — кухни на заказ",
      words: [
        ["кухни на заказ", 72, 11], ["кухня на заказ цена за метр", 58, 7], ["кухни на заказ недорого", 47, 6],
        ["заказать кухню с установкой", 54, 5], ["кухня модерн на заказ", 46, 3], ["белая кухня на заказ", 50, 4],
        ["кухня своими руками", 22, 0], ["столешница для кухни купить", 34, 1], ["кухня пм на заказ", 49, 4], ["проект кухни бесплатно", 40, 2],
      ],
    },
  ];
  for (const kd of kwData) {
    const campId = campIds[kd.camp];
    for (const [text, bid, conv] of kd.words) {
      const clicks = ri(18, 240);
      const impressions = Math.round(clicks / rf(0.03, 0.09));
      await db.insert(keywords).values({
        campaignId: campId,
        text,
        bid: Math.round(bid * 10) / 10,
        impressions,
        clicks,
        spend: Math.round(clicks * bid * rf(0.72, 0.95)),
        conversions: conv,
        qualityScore: conv > 3 ? ri(7, 10) : conv > 0 ? ri(5, 8) : ri(3, 6),
      });
    }
  }

  await db.insert(negativeKeywords).values([
    { campaignId: campIds["Поиск — Диваны на заказ"], text: "ремонт", source: "system" },
    { campaignId: campIds["Поиск — Кухни под заказ Москва"], text: "самостоятельно", source: "system" },
  ]);

  console.log("→ Чаты Авито...");
  const chatSeed = [
    { listing: "Диван-кровать «Осло»", customer: "Марина К.", status: "lead", msgs: 12, last: "Отлично, оформляем доставку на субботу. Спасибо!", hours: 26 },
    { listing: "Кухонный гарнитур «Лофт», 3 м", customer: "Дмитрий В.", status: "lead", msgs: 18, last: "Замерщик приедет в четверг в 18:00, подтверждаю.", hours: 49 },
    { listing: "Шкаф-купе с зеркалом", customer: "Ольга С.", status: "consult", msgs: 7, last: "А можно другой цвет профиля? Венге есть?", hours: 8 },
    { listing: "Офисное кресло ErgoLine", customer: "Игорь П.", status: "consult", msgs: 5, last: "Подскажите, есть ли подлокотники с регулировкой?", hours: 14 },
    { listing: "Детская кровать-чердак", customer: "Анна Т.", status: "new", msgs: 2, last: "Здравствуйте! Ещё продаётся?", hours: 3 },
    { listing: "Стол обеденный раздвижной", customer: "Сергей Л.", status: "new", msgs: 1, last: "Добрый день, какая длина в разложенном виде?", hours: 5 },
    { listing: "Комод «Скандинавия»", customer: "Виктор Н.", status: "closed", msgs: 9, last: "К сожалению, нашёл ближе к дому. Извините.", hours: 70 },
  ];
  for (const c of chatSeed) {
    const started = new Date();
    started.setHours(started.getHours() - c.hours);
    await db.insert(chats).values({
      listingId: campIds[c.listing] ?? null,
      customer: c.customer,
      startedAt: started,
      messagesCount: c.msgs,
      status: c.status,
      lastMessage: c.last,
    });
  }

  console.log("→ Рекомендации...");
  const recSeed = [
    { platform: "google", camp: "Поиск — Диваны на заказ", type: "negative_keywords", description: "Отминусовать «б/у» и «авито» в кампании «Поиск — Диваны на заказ»: 39 нецелевых кликов за 14 дней.", impact: "Экономия ≈ 820 ₽/нед" },
    { platform: "google", camp: "YouTube — Имиджевый ролик", type: "pause", description: "CTR YouTube-кампании 0,35% — ниже порога 1%. Поставить на паузу и перераспределить бюджет.", impact: "Экономия ≈ 4 900 ₽/мес" },
    { platform: "yandex", camp: "Поиск — диваны москва купить", type: "bids_up", description: "Повысить ставки на 10% по 12 ключам с конверсиями — упущенные показы в спецразмещении.", impact: "+15–20% конверсий" },
    { platform: "yandex", camp: "Товарная кампания — Фильтр", type: "pause", description: "Товарная кампания с CTR 0,6% расходует бюджет без конверсий.", impact: "Экономия ≈ 42 000 ₽/мес" },
    { platform: "avito", camp: "Кровать 160×200 с подъёмным механизмом", type: "promote", description: "3 объявления с просмотрами ниже 10/день — подключить услугу «Поднять в поиске».", impact: "+2–3 контакта/день" },
    { platform: "avito", camp: "Комод «Скандинавия»", type: "content", description: "В объявлении «Комод» только 2 фото и нет описания материалов — заполнить карточку.", impact: "+30% просмотров" },
  ];
  for (const r of recSeed) {
    await db.insert(recommendations).values({
      organizationId: ORG,
      platform: r.platform,
      campaignId: campIds[r.camp] ?? null,
      type: r.type,
      description: r.description,
      impact: r.impact,
      status: "open",
    });
  }

  console.log("→ Настройки безопасности...");
  await db.insert(settings).values([
    { organizationId: ORG, key: "dry_run", value: true },
    { organizationId: ORG, key: "read_only", value: true },
    { organizationId: ORG, key: "daily_limit", value: 50000 },
    { organizationId: ORG, key: "weekly_limit", value: 250000 },
    { organizationId: ORG, key: "monthly_limit", value: 900000 },
    { organizationId: ORG, key: "confirm_budget", value: true },
  ]);

  console.log("→ Audit-log и приветствие...");
  await db.insert(auditLog).values([
    { organizationId: ORG, actor: "system", tool: "run_account_audit", params: { platforms: ["google", "yandex", "avito"] }, platforms: "google,yandex,avito", dryRun: false, status: "ok", summary: "Плановый аудит: 6 рекомендаций создано" },
    { organizationId: ORG, actor: "chat", tool: "get_spend_report", params: { days: 7 }, platforms: "google,yandex,avito", dryRun: false, status: "ok", summary: "Сводный расход за 7 дней" },
  ]);
  await db.insert(messages).values({
    organizationId: ORG,
    role: "agent",
    content:
      "Привет! Я Unified AI Ads Agent — управляю рекламой в Google Ads, Яндекс.Директе и на Авито из одного окна. Пишите команды на русском или английском, например: «Покажи расходы за последние 7 дней» или «Поставь на паузу кампании с CTR ниже 1%». Все изменения проходят через safety-слой: dry-run, лимиты и подтверждения.",
    meta: null,
  });

  console.log("✓ Сид завершён.");
  process.exit(0);
}

// helper to reference pendingActions without import order issues
import { pendingActions } from "./schema";
function pendingActionsTable() {
  return pendingActions;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
