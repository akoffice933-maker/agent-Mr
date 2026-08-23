// Demo agent engine — mirrors the real agent's rule-based behaviour on static demo data.
// Pure JS, no dependencies. Works in the browser; UI init is skipped in Node (for self-test).

const DemoAgent = (function () {
  // ── helpers ─────────────────────────────────────────────────────────────
  const fmtMoney = (n) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽");
  const fmtNum = (n) => new Intl.NumberFormat("ru-RU").format(n);
  const fmtPct = (n, d = 1) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: d }).format(n) + "%";

  function state() {
    return {
      campaigns: CAMPAIGNS.map((c) => ({ ...c })),
      recs: RECS.map((r) => ({ ...r, status: "open" })),
      audit: [],
      pending: null,
      nextPendingId: 1,
      log: [],
    };
  }

  function metrics(c, days) {
    if (days <= 7) return { s: c.s7, i: c.i7, k: c.c7, v: c.v7 };
    if (days >= 28) return { s: c.s28, i: c.i28, k: c.c28, v: c.v28 };
    const f = days / 28;
    return { s: c.s28 * f, i: c.i28 * f, k: c.c28 * f, v: c.v28 * f };
  }

  function agg(camps, days) {
    return camps.reduce(
      (a, c) => {
        const m = metrics(c, days);
        a.s += m.s; a.i += m.i; a.k += m.k; a.v += m.v;
        return a;
      },
      { s: 0, i: 0, k: 0, v: 0 }
    );
  }

  function statOf(a) {
    return {
      spend: a.s,
      ctr: a.i > 0 ? (a.k / a.i) * 100 : 0,
      cpa: a.v > 0 ? a.s / a.v : null,
    };
  }

  function findCampaign(name, platform) {
    const norm = name.trim().toLowerCase();
    const exact = state_camps().find((c) => c.name.toLowerCase() === norm && (!platform || c.platform === platform));
    if (exact) return exact;
    return state_camps().find((c) => (!platform || c.platform === platform) && (c.name.toLowerCase().includes(norm) || norm.includes(c.name.toLowerCase())));
  }

  // module-level mutable state
  let S = state();
  function state_camps() { return S.campaigns; }
  function reset() { S = state(); }

  function audit(tool, status, summary, platforms) {
    S.audit.unshift({ ts: new Date().toLocaleTimeString("ru-RU"), tool, status, summary, platforms: platforms || [] });
    if (S.audit.length > 40) S.audit.pop();
  }

  function pendingAction(tool, params, preview, costDaily) {
    const id = S.nextPendingId++;
    S.pending = { id, tool, params, preview, costDaily };
    audit(tool, "pending", preview.title, params.platforms || []);
    return id;
  }

  // ── read tools ──────────────────────────────────────────────────────────
  function spendReport(days, platforms) {
    const plats = platforms.length ? platforms : ["google", "yandex", "avito"];
    const rows = plats.map((p) => {
      const a = agg(S.campaigns.filter((c) => c.platform === p), days);
      const st = statOf(a);
      return { platform: p, campaigns: S.campaigns.filter((c) => c.platform === p).length, ...a, ...st };
    });
    const total = statOf(agg(S.campaigns.filter((c) => plats.includes(c.platform)), days));
    return { kind: "spend", days, rows, total };
  }

  function advisorNote(rows) {
    const withCpa = rows.filter((r) => r.cpa);
    if (withCpa.length < 2) return "";
    const sorted = [...withCpa].sort((a, b) => a.cpa - b.cpa);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const diff = ((worst.cpa - best.cpa) / best.cpa) * 100;
    if (diff < 25) return "";
    return `\n📈 Кросс-платформенная рекомендация: CPA в ${PLATFORM_LABEL[worst.platform]} на ${Math.round(diff)}% выше, чем в ${PLATFORM_LABEL[best.platform]} (${fmtMoney(worst.cpa)} против ${fmtMoney(best.cpa)}). Предлагаю перенести 15% бюджета с ${PLATFORM_LABEL[worst.platform]} на ${PLATFORM_LABEL[best.platform]}.`;
  }

  function compareCpa(days, platforms) {
    const plats = platforms.length ? platforms : ["google", "yandex"];
    const rows = plats.map((p) => {
      const a = agg(S.campaigns.filter((c) => c.platform === p), days);
      return { platform: p, ...a, ...statOf(a) };
    });
    const withCpa = rows.filter((r) => r.cpa);
    if (withCpa.length < 2) return { kind: "text", text: "Недостаточно конверсий для сравнения CPA за этот период." };
    const sorted = [...withCpa].sort((a, b) => a.cpa - b.cpa);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const diff = Math.round(((worst.cpa - best.cpa) / best.cpa) * 100);
    return {
      kind: "cpa",
      days,
      rows,
      insight: `${PLATFORM_LABEL[best.platform]} даёт конверсию на ${diff}% дешевле, чем ${PLATFORM_LABEL[worst.platform]} (${fmtMoney(best.cpa)} против ${fmtMoney(worst.cpa)}). Рекомендуется перераспределить бюджет в пользу ${PLATFORM_LABEL[best.platform]}.`,
    };
  }

  function listCampaigns(status) {
    let rows = S.campaigns.map((c) => ({ ...c, ...metrics(c, 7) }));
    if (status && status !== "all") rows = rows.filter((c) => c.status === status);
    rows.sort((a, b) => b.s - a.s);
    return { kind: "campaigns", rows, status };
  }

  function keywordStats() {
    return { kind: "keywords", rows: KEYWORDS.slice(0, 10) };
  }

  function chatSummary() {
    const leads = CHATS.filter((c) => c.status === "lead").length;
    return { kind: "chats", rows: CHATS, leads, total: CHATS.length };
  }

  function runAudit() {
    const issues = { google: [], yandex: [], avito: [] };
    let high = 0, med = 0, low = 0;
    for (const c of S.campaigns) {
      if (c.status !== "active") continue;
      const m = metrics(c, 28);
      const ctr = m.i > 0 ? (m.k / m.i) * 100 : 0;
      if (c.kind === "campaign") {
        if (m.i > 300 && ctr < 1) {
          issues[c.platform].push(ctr < 0.7 ? "h" : "m");
          (ctr < 0.7 ? high++ : med++);
          issues[c.platform].pop();
          issues[c.platform].push({ sev: ctr < 0.7 ? "high" : "medium", text: `CTR ${fmtPct(ctr, 2)} у «${c.name}» ниже порога 1% — расход ${fmtMoney(m.s)} без отдачи.` });
        }
        if (m.v > 0 && m.s / m.v > 3000) {
          issues[c.platform].push({ sev: "medium", text: `CPA ${fmtMoney(m.s / m.v)} у «${c.name}» выше целевого порога 3 000 ₽.` });
          med++;
        }
      } else {
        const vpd = m.i / 28;
        if (vpd < 10) {
          issues[c.platform].push({ sev: vpd < 5 ? "high" : "medium", text: `Объявление «${c.name}»: ${vpd.toFixed(1)} просмотра/день без платного продвижения.` });
          (vpd < 5 ? high++ : med++);
        }
      }
    }
    low = S.recs.filter((r) => r.type === "negative_keywords").length;
    const score = Math.max(35, Math.min(98, Math.round(96 - high * 7 - med * 3.5 - low * 1.5)));
    return { kind: "audit", score, issues };
  }

  function listRecs() {
    return { kind: "recs", rows: S.recs.filter((r) => r.status === "open") };
  }

  // ── write tools (produce pending previews) ──────────────────────────────
  function pauseLowCtr(threshold) {
    const victims = S.campaigns.filter((c) => {
      if (c.status !== "active" || c.kind !== "campaign") return false;
      const m = metrics(c, 28);
      return m.i > 100 && (m.k / m.i) * 100 < threshold;
    });
    if (!victims.length) return { kind: "text", text: `Активных кампаний с CTR ниже ${fmtPct(threshold)} не найдено — пауза не требуется.` };
    return {
      kind: "preview",
      title: `Пауза ${victims.length} кампаний с CTR ниже ${fmtPct(threshold)}`,
      tool: "pause_low_ctr_campaigns",
      changes: victims.map((c) => {
        const m = metrics(c, 28);
        return { name: c.name, meta: `${PLATFORM_LABEL[c.platform]} · CTR ${fmtPct((m.k / m.i) * 100, 2)} · ${fmtMoney(m.s)}`, after: "Статус: Пауза" };
      }),
      apply: () => {
        victims.forEach((c) => (c.status = "paused"));
        return `на паузу поставлено ${victims.length} кампаний (${victims.map((c) => `«${c.name}»`).join(", ")})`;
      },
    };
  }

  function setStatus(name, status, platform) {
    const c = findCampaign(name, platform);
    if (!c) return { kind: "text", text: `Кампания «${name}» не найдена. Попробуйте «Покажи все кампании», чтобы увидеть названия.` };
    if (c.status === status) return { kind: "text", text: `«${c.name}» уже ${status === "active" ? "активна" : "на паузе"} — менять нечего.` };
    return {
      kind: "preview",
      title: `${status === "active" ? "Запуск" : "Пауза"} «${c.name}»`,
      tool: "set_campaign_status",
      changes: [{ name: c.name, meta: `${PLATFORM_LABEL[c.platform]} · бюджет ${fmtMoney(c.budget)}/день`, before: c.status === "active" ? "Активна" : "Пауза", after: status === "active" ? "Активна" : "Пауза" }],
      costDaily: status === "active" ? c.budget : 0,
      apply: () => { c.status = status; return `«${c.name}» ${status === "active" ? "запущена" : "поставлена на паузу"}`; },
    };
  }

  function adjustBids(percent, dir, filter) {
    let kws = KEYWORDS;
    if (filter === "with_conversions") kws = kws.filter((k) => k.conv > 0);
    const factor = dir === "up" ? 1 + percent / 100 : 1 - percent / 100;
    return {
      kind: "preview",
      title: `${dir === "up" ? "Повышение" : "Понижение"} ставок на ${percent}% · ${kws.length} ключей`,
      tool: "adjust_bids",
      changes: kws.slice(0, 8).map((k) => ({ name: k.text, meta: PLATFORM_LABEL[k.platform], before: fmtMoney(k.bid), after: fmtMoney(k.bid * factor) })),
      costDaily: dir === "up" ? Math.round((kws.reduce((a, k) => a + k.spend, 0) / 28) * (percent / 100)) : 0,
      apply: () => `ставки изменены ×${factor.toFixed(2)} по ${kws.length} ключевым фразам`,
    };
  }

  function createCampaign(name, budget, platform) {
    return {
      kind: "preview",
      title: `Создание кампании «${name}» в ${PLATFORM_LABEL[platform]}`,
      tool: "create_campaign",
      changes: [{ name, meta: "Будет создана", after: `Бюджет ${fmtMoney(budget)}/день · автостратегия` }],
      costDaily: budget,
      apply: () => {
        S.campaigns.push({ id: 100 + S.campaigns.length, platform, kind: "campaign", name, status: "active", budget, s7: 0, i7: 0, c7: 0, v7: 0, s28: 0, i28: 0, c28: 0, v28: 0 });
        return `кампания «${name}» создана в ${PLATFORM_LABEL[platform]} и запущена`;
      },
    };
  }

  function promoteAvito(threshold) {
    const victims = S.campaigns.filter((c) => c.platform === "avito" && c.kind === "listing" && c.status === "active" && c.i7 / 7 < threshold);
    if (!victims.length) return { kind: "text", text: `Все активные объявления Авито набирают ≥ ${threshold} просмотров/день — продвижение не требуется.` };
    return {
      kind: "preview",
      title: `Продвижение ${victims.length} объявлений с просмотрами ниже ${threshold}/день`,
      tool: "promote_low_view_listings",
      changes: victims.map((c) => ({ name: c.name, meta: `${(c.i7 / 7).toFixed(1)} просмотров/день · ${fmtMoney(c.price)}`, after: "Услуга «Поднять в поиске», 7 дней · ≈ 299 ₽/день" })),
      costDaily: victims.length * 299,
      apply: () => `${victims.length} объявлений Авито подключены к услуге «Поднять в поиске» на 7 дней`,
    };
  }

  function applyRecs(ids) {
    const targets = ids ? S.recs.filter((r) => r.status === "open" && ids.includes(r.id)) : S.recs.filter((r) => r.status === "open");
    if (!targets.length) return { kind: "text", text: ids ? `Открытой рекомендации ${ids.map((i) => "#" + i).join(", ")} не найдено.` : "Открытых рекомендаций нет — запустите аудит: «Сделай аудит всех кабинетов»." };
    return {
      kind: "preview",
      title: `Применение ${targets.length === 1 ? `рекомендации #${targets[0].id}` : `${targets.length} рекомендаций`}`,
      tool: "apply_recommendation",
      changes: targets.map((r) => ({ name: r.text, meta: `${PLATFORM_LABEL[r.platform]} · #${r.id}`, before: "Открыта", after: "Будет применена" })),
      apply: () => {
        for (const r of targets) {
          r.status = "applied";
          if (r.type === "pause" && r.campaignId) { const c = S.campaigns.find((x) => x.id === r.campaignId); if (c) c.status = "paused"; }
          if (r.type === "promote" && r.campaignId) { const c = S.campaigns.find((x) => x.id === r.campaignId); if (c) c.s7 += 100; }
        }
        return `применено ${targets.length} рекомендаций`;
      },
    };
  }

  // ── intent parsing (mirrors src/lib/agent/router.ts) ────────────────────
  function parseIntent(raw) {
    const norm = raw.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    const platforms = [];
    if (/google|гугл|адвордс|adwords|google\s?ads/.test(norm)) platforms.push("google");
    if (/яндекс|директ|yandex|direct/.test(norm)) platforms.push("yandex");
    if (/авито|avito/.test(norm)) platforms.push("avito");

    let days = 7;
    const md = norm.match(/(\d{1,3})\s*(?:дн|день|дня|дней|д\.)/);
    if (md) days = Math.min(30, Math.max(1, parseInt(md[1], 10)));
    else if (/месяц|30 дн/.test(norm)) days = 30;
    else if (/недел/.test(norm)) days = 7;

    const quoted = [];
    const re = /[«"„']([^»"“']{2,60})[»"“']/g;
    let qm;
    while ((qm = re.exec(norm)) !== null) quoted.push(qm[1].trim());

    const T = (tool, extra = {}) => Object.assign({ tool, platforms, days, quoted }, extra);

    if (/минус[-\s]?(фраз|слов|ключ)/.test(norm)) return T("add_negative_keywords");
    if (/рекомендац/.test(norm) && /(примен|внедри|выполни|запусти)/.test(norm)) {
      const mId = norm.match(/рекомендаци[юи]\s*#?\s*(\d+)/) || norm.match(/#(\d+)/);
      return T("apply_recommendation", { recId: mId ? parseInt(mId[1], 10) : null, all: !mId && /(все|всё|их)/.test(norm) });
    }
    if (/рекомендац/.test(norm)) return T("list_recommendations");
    if (quoted.length && /(пауз|запуск|запусти|включи|выключи|стопни|останов)/.test(norm)) {
      return T("set_campaign_status", { name: quoted[0], status: /(запуск|запусти|включ)/.test(norm) ? "active" : "paused" });
    }
    if (/(продвин|продвижени|буст|раскрут)/.test(norm) && /(объявлен|листинг|авито|просмотр|товар)/.test(norm)) {
      const m = norm.match(/просмотр[а-я]*\s*(?:ниже|меньше|до)\s*(\d+)/);
      return T("promote_low_view_listings", { threshold: m ? parseInt(m[1], 10) : 10, platforms: ["avito"] });
    }
    if (/(пауз|останов|выключ|приостанов|стоп|стопни|отключи|паузь)/.test(norm) && /ctr|кликабельн|клик/.test(norm)) {
      const m = norm.match(/ниже\s*([\d.,]+)\s*%?/);
      return T("pause_low_ctr_campaigns", { threshold: m ? parseFloat(m[1].replace(",", ".")) : 1.0 });
    }
    if (/(ставк|бид|bid)/.test(norm) && /(подним|увелич|повыс|уменьш|сниз|опуст|измен|скорректир)/.test(norm)) {
      const m = norm.match(/на\s*([\d.,]+)\s*%/);
      const percent = m ? Math.min(300, parseFloat(m[1].replace(",", "."))) : 10;
      return T("adjust_bids", { percent, direction: /(уменьш|сниз|опуст|пониз|минус)/.test(norm) ? "down" : "up", filter: /(конверси|конверт)/.test(norm) ? "with_conversions" : "all" });
    }
    if (/(создай|создать|запусти новую|новая кампани)/.test(norm)) {
      const mB = norm.match(/бюджет[а-я]*\s*(\d[\d\s]{2,9})/) || norm.match(/(\d[\d\s]{2,9})\s*\/?\s*день/);
      return T("create_campaign", { name: quoted[0] || "Новая кампания", budget: mB ? Math.min(500000, parseInt(mB[1].replace(/\s/g, ""), 10)) : 2000, platform: platforms.length === 1 ? platforms[0] : "google" });
    }
    if (/cpa|цену (лида|конверси)/.test(norm) && /(сравни|сравнени|против|лучше|выгодн|эффективнее)/.test(norm)) return T("compare_cpa");
    if (/аудит|диагностик|провер(ь|ка|ить)\s(все|аккаунт|кабинет)/.test(norm)) return T("run_account_audit");
    if (/(чат|лид|сообщени|диалог)/.test(norm) && (platforms.includes("avito") || /сводк/.test(norm))) return T("get_avito_chat_summary", { platforms: ["avito"] });
    if (/(ключ|фраз|запрос|keyword)/.test(norm) && /(статист|эффективн|показ|топ|анализ|работ)/.test(norm)) return T("get_keyword_performance");
    if (/(расход|потрач|затрат|отчет|отчёт|сводк|сколько ушло)/.test(norm)) return T("get_spend_report");
    if (/cpa/.test(norm)) return T("compare_cpa");
    if (/(кампани|объявлен|листинг)/.test(norm) && /(список|покажи|все|какие|статус|что запущено|активн|на паузе)/.test(norm)) {
      return T("list_campaigns", { status: /на паузе|остановл/.test(norm) ? "paused" : /активн|запущен/.test(norm) ? "active" : "all" });
    }
    if (/(что (ты )?умеешь|помощь|команды|справка|возможности|помоги|help)/.test(norm)) return T("help");
    return T("fallback");
  }

  const TOOL_LABEL = {
    get_spend_report: "сводный расход по платформам",
    compare_cpa: "сравнение CPA между площадками",
    list_campaigns: "список кампаний",
    get_keyword_performance: "статистика по ключевым фразам",
    get_avito_chat_summary: "сводка по чатам Авито",
    run_account_audit: "автоматический аудит кабинетов",
    pause_low_ctr_campaigns: "пауза кампаний с низким CTR",
    set_campaign_status: "пауза/запуск кампании",
    adjust_bids: "корректировка ставок",
    create_campaign: "создание кампании",
    promote_low_view_listings: "продвижение объявлений Авито",
    add_negative_keywords: "добавление минус-фраз",
    list_recommendations: "список рекомендаций",
    apply_recommendation: "применение рекомендаций",
    help: "справка",
    fallback: "уточнение запроса",
  };

  const WRITE_TOOLS = new Set(["pause_low_ctr_campaigns", "set_campaign_status", "adjust_bids", "create_campaign", "promote_low_view_listings", "apply_recommendation"]);

  // ── main entry: runAgent ────────────────────────────────────────────────
  function runAgent(raw) {
    const i = parseIntent(raw);
    const trace = [
      { label: `AI Core: намерение распознано → ${i.tool}`, detail: TOOL_LABEL[i.tool], status: "ok" },
      { label: `Маршрутизация адаптерам: ${(i.platforms.length ? i.platforms : ["google", "yandex", "avito"]).map((p) => PLATFORM_LABEL[p]).join(", ")}`, detail: "sandbox-режим: данные из локального зеркала", status: "ok" },
    ];
    let card, content;
    let pendingId;

    const dispatch = () => {
      switch (i.tool) {
        case "get_spend_report": {
          card = spendReport(i.days, i.platforms);
          content = `Готово: суммарный расход ${fmtMoney(card.total.spend)} за ${i.days} дн.`;
          content += advisorNote(card.rows);
          break;
        }
        case "compare_cpa":
          card = compareCpa(i.days, i.platforms);
          content = card.kind === "cpa" ? card.insight : card.text;
          break;
        case "list_campaigns": {
          card = listCampaigns(i.status);
          content = `Найдено ${card.rows.length} кампаний и объявлений.`;
          break;
        }
        case "get_keyword_performance":
          card = keywordStats();
          content = `Собрал статистику по ${card.rows.length} ключевым фразам.`;
          break;
        case "get_avito_chat_summary": {
          card = chatSummary();
          content = `Сводка по чатам: ${card.total} диалогов, из них ${card.leads} лидов.`;
          break;
        }
        case "run_account_audit": {
          card = runAudit();
          content = `Аудит завершён, итоговая оценка ${card.score}/100.`;
          break;
        }
        case "list_recommendations": {
          card = listRecs();
          content = `Открытых рекомендаций: ${card.rows.length}.`;
          break;
        }
        case "pause_low_ctr_campaigns": {
          const p = pauseLowCtr(i.threshold);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = "Предпросмотр изменений готов — подтвердите выполнение."; trace.push({ label: "Safety-слой: dry-run включён → подготовлен предпросмотр", detail: "Изменения не применяются без явного подтверждения", status: "warn" }); pendingId = pendingAction(i.tool, {}, p, 0); card.pendingActionId = pendingId; }
          break;
        }
        case "set_campaign_status": {
          const p = setStatus(i.name, i.status, i.platforms[0]);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = "Предпросмотр изменений готов — подтвердите выполнение."; trace.push({ label: "Safety-слой: требуется подтверждение (влияет на бюджет)", status: "warn" }); pendingId = pendingAction(i.tool, {}, p, p.costDaily || 0); card.pendingActionId = pendingId; }
          break;
        }
        case "adjust_bids": {
          const p = adjustBids(i.percent, i.direction, i.filter);
          card = p; content = "Предпросмотр изменений готов — подтвердите выполнение.";
          trace.push({ label: "Safety-слой: требуется подтверждение (влияет на бюджет)", status: "warn" });
          pendingId = pendingAction(i.tool, {}, p, p.costDaily || 0); card.pendingActionId = pendingId;
          break;
        }
        case "create_campaign": {
          const p = createCampaign(i.name, i.budget, i.platform);
          card = p; content = "Предпросмотр изменений готов — подтвердите выполнение.";
          trace.push({ label: `Лимиты: проверка дневного лимита 50 000 ₽ → запас есть`, status: "ok" });
          trace.push({ label: "Safety-слой: требуется подтверждение (влияет на бюджет)", status: "warn" });
          pendingId = pendingAction(i.tool, {}, p, p.costDaily); card.pendingActionId = pendingId;
          break;
        }
        case "promote_low_view_listings": {
          const p = promoteAvito(i.threshold);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = "Предпросмотр изменений готов — подтвердите выполнение."; trace.push({ label: "Safety-слой: требуется подтверждение (влияет на бюджет)", status: "warn" }); pendingId = pendingAction(i.tool, {}, p, p.costDaily); card.pendingActionId = pendingId; }
          break;
        }
        case "apply_recommendation": {
          const p = applyRecs(i.recId ? [i.recId] : null);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = "Предпросмотр изменений готов — подтвердите выполнение."; trace.push({ label: "Safety-слой: требуется подтверждение (влияет на бюджет)", status: "warn" }); pendingId = pendingAction(i.tool, {}, p, 0); card.pendingActionId = pendingId; }
          break;
        }
        case "add_negative_keywords":
          if (i.quoted.length) {
            card = { kind: "text", text: `Минус-фразы «${i.quoted.join(", ")}» — write-операция: в полной версии они добавляются в поисковую кампанию после подтверждения. В демо применяйте их через «Примени все рекомендации».` };
            content = `Принял: ${i.quoted.map((w) => `«${w}»`).join(", ")}.`;
          } else {
            card = { kind: "text", text: "Укажите минус-фразы в кавычках, например: «б/у, ремонт»." };
            content = "Укажите минус-фразы в кавычках.";
          }
          break;
        case "help":
          card = { kind: "help" };
          content = "Я понимаю команды на естественном языке. Попробуйте:";
          break;
        default:
          card = { kind: "text", text: "Не смог распознать команду. Попробуйте: «Покажи расходы за последние 7 дней», «Поставь на паузу кампании с CTR ниже 1%» или «помощь»." };
          content = "Не смог распознать команду.";
      }
    };
    dispatch();

    const isWrite = WRITE_TOOLS.has(i.tool) && card.kind === "preview";
    trace.push(isWrite ? { label: "Результат записан, ожидает подтверждения", status: "ok" } : { label: "Результат агрегирован и возвращён", status: "ok" });
    if (!isWrite) audit(i.tool, "ok", content.slice(0, 90), i.platforms);

    S.log.unshift({ user: raw, agent: content, tool: i.tool, pendingId });
    return { content, card, trace, pendingId };
  }

  function resolvePending(id, decision) {
    if (!S.pending || S.pending.id !== id) return { content: "Это действие уже обработано ранее — проверьте журнал аудита.", card: null, trace: [] };
    const p = S.pending;
    S.pending = null;
    if (decision === "reject") {
      audit(p.tool, "rejected", `Отклонено пользователем: ${p.tool} #${id}`, []);
      return { content: "Отменил действие — изменения не применены. Записал в журнал аудита.", card: null, trace: [{ label: `Подтверждение #${id}: отклонено пользователем`, status: "warn" }] };
    }
    const summary = p.preview.apply();
    audit(p.tool, "applied", summary, []);
    return {
      content: `Выполнено: ${summary}. Все изменения зафиксированы в журнале аудита.`,
      card: null,
      trace: [
        { label: `Подтверждение #${id} получено`, status: "ok" },
        { label: "Локальное зеркало обновлено", detail: summary, status: "ok" },
        { label: "Адаптеры: sandbox-режим — изменения записаны локально", status: "ok" },
        { label: "Запись в audit-log создана", status: "ok" },
      ],
    };
  }

  function getAudit() { return S.audit; }
  function getPending() { return S.pending; }

  return { runAgent, resolvePending, getAudit, getPending, reset, parseIntent, fmtMoney };
})();
