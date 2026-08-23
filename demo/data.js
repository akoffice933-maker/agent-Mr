// Demo data — exported from the real seed (28 days) of the agent DB.
const CAMPAIGNS = [
  { id: 61, platform: "google", kind: "campaign", name: "Поиск — Диваны на заказ", status: "active", budget: 3500, s7: 17447, i7: 8652, c7: 398, v7: 22, s28: 78760, i28: 39021, c28: 1795, v28: 100 },
  { id: 62, platform: "google", kind: "campaign", name: "Поиск — Кухни под заказ Москва", status: "active", budget: 3000, s7: 18246, i7: 8872, c7: 346, v7: 18, s28: 69046, i28: 34949, c28: 1363, v28: 67 },
  { id: 63, platform: "google", kind: "campaign", name: "Performance Max — Мебель для дома", status: "active", budget: 5000, s7: 26020, i7: 30096, c7: 933, v7: 42, s28: 116527, i28: 139546, c28: 4326, v28: 185 },
  { id: 64, platform: "google", kind: "campaign", name: "Display — Ретаргетинг каталога", status: "active", budget: 1200, s7: 6168, i7: 61223, c7: 551, v7: 9, s28: 24442, i28: 227333, c28: 2046, v28: 35 },
  { id: 65, platform: "google", kind: "campaign", name: "Shopping — Каталог товаров", status: "paused", budget: 2000, s7: 0, i7: 0, c7: 0, v7: 0, s28: 30407, i28: 96285, c28: 2022, v28: 63 },
  { id: 66, platform: "google", kind: "campaign", name: "YouTube — Имиджевый ролик", status: "active", budget: 900, s7: 4467, i7: 162571, c7: 569, v7: 0, s28: 18487, i28: 654283, c28: 2290, v28: 0 },
  { id: 67, platform: "yandex", kind: "campaign", name: "Поиск — диваны москва купить", status: "active", budget: 3200, s7: 17315, i7: 8550, c7: 436, v7: 27, s28: 73455, i28: 35491, c28: 1810, v28: 118 },
  { id: 68, platform: "yandex", kind: "campaign", name: "Поиск — кухни на заказ", status: "active", budget: 2800, s7: 14988, i7: 7721, c7: 332, v7: 19, s28: 64036, i28: 33790, c28: 1453, v28: 78 },
  { id: 69, platform: "yandex", kind: "campaign", name: "РСЯ — Ретаргетинг", status: "active", budget: 1500, s7: 7590, i7: 44582, c7: 535, v7: 14, s28: 31391, i28: 190666, c28: 2288, v28: 58 },
  { id: 70, platform: "yandex", kind: "campaign", name: "Смарт-баннеры — Каталог", status: "active", budget: 1100, s7: 5530, i7: 31834, c7: 573, v7: 14, s28: 22272, i28: 120777, c28: 2174, v28: 57 },
  { id: 71, platform: "yandex", kind: "campaign", name: "Мастер кампаний — Акция −20%", status: "paused", budget: 1000, s7: 0, i7: 0, c7: 0, v7: 0, s28: 14793, i28: 29070, c28: 814, v28: 30 },
  { id: 72, platform: "yandex", kind: "campaign", name: "Товарная кампания — Фильтр", status: "active", budget: 1800, s7: 9235, i7: 116334, c7: 698, v7: 10, s28: 38209, i28: 503500, c28: 3021, v28: 37 },
  { id: 73, platform: "avito", kind: "listing", name: "Диван-кровать «Осло»", status: "active", budget: 300, price: 89900, s7: 1194, i7: 401, c7: 21, v7: 9, s28: 5022, i28: 1514, c28: 82, v28: 35 },
  { id: 74, platform: "avito", kind: "listing", name: "Кухонный гарнитур «Лофт», 3 м", status: "active", budget: 300, price: 145000, s7: 1012, i7: 281, c7: 15, v7: 7, s28: 4032, i28: 1207, c28: 59, v28: 26 },
  { id: 75, platform: "avito", kind: "listing", name: "Шкаф-купе с зеркалом", status: "active", budget: 200, price: 42500, s7: 777, i7: 245, c7: 12, v7: 5, s28: 2977, i28: 918, c28: 46, v28: 21 },
  { id: 76, platform: "avito", kind: "listing", name: "Кровать 160×200 с подъёмным механизмом", status: "active", budget: 150, price: 54900, s7: 38, i7: 32, c7: 0, v7: 0, s28: 143, i28: 129, c28: 0, v28: 0 },
  { id: 77, platform: "avito", kind: "listing", name: "Комод «Скандинавия»", status: "active", budget: 100, price: 18900, s7: 32, i7: 28, c7: 0, v7: 0, s28: 133, i28: 114, c28: 0, v28: 0 },
  { id: 78, platform: "avito", kind: "listing", name: "Офисное кресло ErgoLine", status: "active", budget: 200, price: 24900, s7: 1089, i7: 419, c7: 21, v7: 9, s28: 4832, i28: 1761, c28: 91, v28: 38 },
  { id: 79, platform: "avito", kind: "listing", name: "Стол обеденный раздвижной", status: "active", budget: 150, price: 36700, s7: 43, i7: 39, c7: 0, v7: 0, s28: 196, i28: 172, c28: 1, v28: 1 },
  { id: 80, platform: "avito", kind: "listing", name: "Детская кровать-чердак", status: "active", budget: 200, price: 29900, s7: 567, i7: 174, c7: 9, v7: 2, s28: 2573, i28: 776, c28: 40, v28: 12 },
];

const PLATFORM_TOTALS = {
  7: { avito: { s: 4751, i: 1619, c: 78, v: 32 }, google: { s: 72349, i: 271414, c: 2797, v: 91 }, yandex: { s: 54658, i: 209021, c: 2574, v: 84 } },
  30: { avito: { s: 19907, i: 6591, c: 319, v: 133 }, google: { s: 337670, i: 1191417, c: 13842, v: 450 }, yandex: { s: 244155, i: 913294, c: 11560, v: 378 } },
};

const KEYWORDS = [
  { text: "кухни на заказ", bid: 72, spend: 12130, clicks: 224, conv: 11, platform: "yandex" },
  { text: "кухня под заказ москва", bid: 68, spend: 9464, clicks: 149, conv: 10, platform: "google" },
  { text: "заказать кухню с установкой", bid: 54, spend: 9198, clicks: 196, conv: 5, platform: "yandex" },
  { text: "диваны москва купить", bid: 56, spend: 9105, clicks: 216, conv: 13, platform: "yandex" },
  { text: "диван от производителя москва", bid: 45, spend: 8356, clicks: 231, conv: 8, platform: "yandex" },
  { text: "маленькая кухня на заказ", bid: 48, spend: 8203, clicks: 204, conv: 3, platform: "google" },
  { text: "купить диван от производителя", bid: 47, spend: 7998, clicks: 225, conv: 9, platform: "google" },
  { text: "магазин диванов москва", bid: 43, spend: 7633, clicks: 193, conv: 4, platform: "yandex" },
  { text: "купить диван кровать недорого", bid: 41, spend: 7548, clicks: 227, conv: 6, platform: "yandex" },
  { text: "изготовление диванов под заказ", bid: 51, spend: 7453, clicks: 192, conv: 5, platform: "google" },
  { text: "белая кухня на заказ", bid: 50, spend: 7313, clicks: 201, conv: 4, platform: "yandex" },
  { text: "кухня модерн на заказ", bid: 46, spend: 7174, clicks: 212, conv: 3, platform: "yandex" },
  { text: "кухня на заказ цена за метр", bid: 58, spend: 7132, clicks: 162, conv: 7, platform: "yandex" },
  { text: "диван на заказ москва", bid: 62, spend: 6587, clicks: 128, conv: 12, platform: "google" },
];

const RECS = [
  { id: 21, platform: "google", type: "negative_keywords", text: "Отминусовать «б/у» и «авито» в кампании «Поиск — Диваны на заказ»: 39 нецелевых кликов за 14 дней.", impact: "Экономия ≈ 820 ₽/нед" },
  { id: 22, platform: "google", type: "pause", text: "CTR YouTube-кампании 0,35% — ниже порога 1%. Поставить на паузу и перераспределить бюджет.", impact: "Экономия ≈ 4 900 ₽/мес" },
  { id: 23, platform: "yandex", type: "bids_up", text: "Повысить ставки на 10% по 12 ключам с конверсиями — упущенные показы в спецразмещении.", impact: "+15–20% конверсий" },
  { id: 24, platform: "yandex", type: "pause", text: "Товарная кампания с CTR 0,6% расходует бюджет без конверсий.", impact: "Экономия ≈ 42 000 ₽/мес" },
  { id: 25, platform: "avito", type: "promote", text: "3 объявления с просмотрами ниже 10/день — подключить услугу «Поднять в поиске».", impact: "+2–3 контакта/день" },
  { id: 26, platform: "avito", type: "content", text: "В объявлении «Комод» только 2 фото и нет описания материалов — заполнить карточку.", impact: "+30% просмотров" },
];

const CHATS = [
  { customer: "Марина К.", status: "lead", msgs: 12, last: "Отлично, оформляем доставку на субботу. Спасибо!" },
  { customer: "Дмитрий В.", status: "lead", msgs: 18, last: "Замерщик приедет в четверг в 18:00, подтверждаю." },
  { customer: "Ольга С.", status: "consult", msgs: 7, last: "А можно другой цвет профиля? Венге есть?" },
  { customer: "Игорь П.", status: "consult", msgs: 5, last: "Подскажите, есть ли подлокотники с регулировкой?" },
  { customer: "Анна Т.", status: "new", msgs: 2, last: "Здравствуйте! Ещё продаётся?" },
  { customer: "Сергей Л.", status: "new", msgs: 1, last: "Добрый день, какая длина в разложенном виде?" },
  { customer: "Виктор Н.", status: "closed", msgs: 9, last: "К сожалению, нашёл ближе к дому. Извините." },
];

const PLATFORM_LABEL = { google: "Google Ads", yandex: "Яндекс.Директ", avito: "Авито" };
const PLATFORM_COLOR = { google: "#6aa6f5", yandex: "#fb5a3c", avito: "#47d185" };
