// Demo agent engine — mirrors the real agent's rule-based behaviour on static demo data.
// Bilingual (RU/EN): parse patterns and response templates for both languages.
// Pure JS, no dependencies. UI init is not here (see ui.js); safe to eval in Node for tests.

const DemoAgent = (function () {
  // ── language ────────────────────────────────────────────────────────────
  let lang = "ru";
  function setLang(l) { lang = l === "en" ? "en" : "ru"; }
  function getLang() { return lang; }
  const t = (ru, en) => (lang === "en" ? en : ru);
  const plLabel = (p) => (lang === "en" ? PLATFORM_LABEL_EN[p] : PLATFORM_LABEL[p]);

  // ── helpers ─────────────────────────────────────────────────────────────
  const fmtMoney = (n) => (n === null || n === undefined ? "—" : new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU").format(Math.round(n)) + (lang === "en" ? " ₽" : " ₽"));
  const fmtNum = (n) => new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU").format(n);
  const fmtPct = (n, d = 1) => new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU", { maximumFractionDigits: d }).format(n) + "%";

  function state() {
    return {
      campaigns: CAMPAIGNS.map((c) => ({ ...c })),
      recs: RECS.map((r) => ({ ...r, status: "open" })),
      audit: [],
      pending: null,
      nextPendingId: 1,
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
    return { spend: a.s, ctr: a.i > 0 ? (a.k / a.i) * 100 : 0, cpa: a.v > 0 ? a.s / a.v : null };
  }

  let S = state();
  const state_camps = () => S.campaigns;
  function reset() { S = state(); }

  function findCampaign(name, platform) {
    const norm = name.trim().toLowerCase();
    const exact = state_camps().find((c) => c.name.toLowerCase() === norm && (!platform || c.platform === platform));
    if (exact) return exact;
    return state_camps().find((c) => (!platform || c.platform === platform) && (c.name.toLowerCase().includes(norm) || norm.includes(c.name.toLowerCase())));
  }

  function audit(tool, status, summary, platforms) {
    S.audit.unshift({ ts: new Date().toLocaleTimeString(lang === "en" ? "en-GB" : "ru-RU"), tool, status, summary, platforms: platforms || [] });
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
      return { platform: p, campaigns: S.campaigns.filter((c) => c.platform === p).length, ...a, ...statOf(a) };
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
    return lang === "en"
      ? `\n📈 Cross-platform suggestion: CPA on ${plLabel(worst.platform)} is ${Math.round(diff)}% higher than on ${plLabel(best.platform)} (${fmtMoney(worst.cpa)} vs ${fmtMoney(best.cpa)}). Suggest moving 15% of budget from ${plLabel(worst.platform)} to ${plLabel(best.platform)}.`
      : `\n📈 Кросс-платформенная рекомендация: CPA в ${plLabel(worst.platform)} на ${Math.round(diff)}% выше, чем в ${plLabel(best.platform)} (${fmtMoney(worst.cpa)} против ${fmtMoney(best.cpa)}). Предлагаю перенести 15% бюджета с ${plLabel(worst.platform)} на ${plLabel(best.platform)}.`;
  }

  function compareCpa(days, platforms) {
    const plats = platforms.length ? platforms : ["google", "yandex"];
    const rows = plats.map((p) => {
      const a = agg(S.campaigns.filter((c) => c.platform === p), days);
      return { platform: p, ...a, ...statOf(a) };
    });
    const withCpa = rows.filter((r) => r.cpa);
    if (withCpa.length < 2) return { kind: "text", text: t("Недостаточно конверсий для сравнения CPA за этот период.", "Not enough conversions to compare CPA for this period.") };
    const sorted = [...withCpa].sort((a, b) => a.cpa - b.cpa);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const diff = Math.round(((worst.cpa - best.cpa) / best.cpa) * 100);
    const insight = lang === "en"
      ? `${plLabel(best.platform)} delivers conversions ${diff}% cheaper than ${plLabel(worst.platform)} (${fmtMoney(best.cpa)} vs ${fmtMoney(worst.cpa)}). Recommend reallocating budget to ${plLabel(best.platform)}.`
      : `${plLabel(best.platform)} даёт конверсию на ${diff}% дешевле, чем ${plLabel(worst.platform)} (${fmtMoney(best.cpa)} против ${fmtMoney(worst.cpa)}). Рекомендуется перераспределить бюджет в пользу ${plLabel(best.platform)}.`;
    return { kind: "cpa", days, rows, insight };
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
          const sev = ctr < 0.7 ? "high" : "medium";
          (sev === "high" ? high++ : med++);
          issues[c.platform].push({ sev, text: lang === "en" ? `CTR ${fmtPct(ctr, 2)} of “${c.name}” is below the 1% threshold — ${fmtMoney(m.s)} spent without return.` : `CTR ${fmtPct(ctr, 2)} у «${c.name}» ниже порога 1% — расход ${fmtMoney(m.s)} без отдачи.` });
        }
        if (m.v > 0 && m.s / m.v > 3000) {
          med++;
          issues[c.platform].push({ sev: "medium", text: lang === "en" ? `CPA ${fmtMoney(m.s / m.v)} of “${c.name}” is above the 3,000 ₽ target.` : `CPA ${fmtMoney(m.s / m.v)} у «${c.name}» выше целевого порога 3 000 ₽.` });
        }
      } else {
        const vpd = m.i / 28;
        if (vpd < 10) {
          const sev = vpd < 5 ? "high" : "medium";
          (sev === "high" ? high++ : med++);
          issues[c.platform].push({ sev, text: lang === "en" ? `Listing “${c.name}”: ${vpd.toFixed(1)} views/day without paid promotion.` : `Объявление «${c.name}»: ${vpd.toFixed(1)} просмотра/день без платного продвижения.` });
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
    if (!victims.length) return { kind: "text", text: t(`Активных кампаний с CTR ниже ${fmtPct(threshold)} не найдено — пауза не требуется.`, `No active campaigns with CTR below ${fmtPct(threshold)} found — no pause needed.`) };
    return {
      kind: "preview",
      title: t(`Пауза ${victims.length} кампаний с CTR ниже ${fmtPct(threshold)}`, `Pause ${victims.length} campaigns with CTR below ${fmtPct(threshold)}`),
      tool: "pause_low_ctr_campaigns",
      changes: victims.map((c) => {
        const m = metrics(c, 28);
        return { name: c.name, meta: `${plLabel(c.platform)} · CTR ${fmtPct((m.k / m.i) * 100, 2)} · ${fmtMoney(m.s)}`, after: t("Статус: Пауза", "Status: Paused") };
      }),
      apply: () => {
        victims.forEach((c) => (c.status = "paused"));
        return lang === "en" ? `${victims.length} campaigns paused (${victims.map((c) => `“${c.name}”`).join(", ")})` : `на паузу поставлено ${victims.length} кампаний (${victims.map((c) => `«${c.name}»`).join(", ")})`;
      },
    };
  }

  function setStatus(name, status, platform) {
    const c = findCampaign(name, platform);
    if (!c) return { kind: "text", text: t(`Кампания «${name}» не найдена. Попробуйте «Покажи все кампании», чтобы увидеть названия.`, `Campaign “${name}” not found. Try “List all campaigns” to see the names.`) };
    if (c.status === status) return { kind: "text", text: t(`«${c.name}» уже ${status === "active" ? "активна" : "на паузе"} — менять нечего.`, `“${c.name}” is already ${status === "active" ? "active" : "paused"} — nothing to change.`) };
    return {
      kind: "preview",
      title: t(`${status === "active" ? "Запуск" : "Пауза"} «${c.name}»`, `${status === "active" ? "Resume" : "Pause"} “${c.name}”`),
      tool: "set_campaign_status",
      changes: [{ name: c.name, meta: `${plLabel(c.platform)} · ${t("бюджет", "budget")} ${fmtMoney(c.budget)}/day`, before: c.status === "active" ? t("Активна", "Active") : t("Пауза", "Paused"), after: status === "active" ? t("Активна", "Active") : t("Пауза", "Paused") }],
      costDaily: status === "active" ? c.budget : 0,
      apply: () => {
        c.status = status;
        return lang === "en" ? `“${c.name}” ${status === "active" ? "resumed" : "paused"}` : `«${c.name}» ${status === "active" ? "запущена" : "поставлена на паузу"}`;
      },
    };
  }

  function adjustBids(percent, dir, filter) {
    let kws = KEYWORDS;
    if (filter === "with_conversions") kws = kws.filter((k) => k.conv > 0);
    const factor = dir === "up" ? 1 + percent / 100 : 1 - percent / 100;
    return {
      kind: "preview",
      title: t(`${dir === "up" ? "Повышение" : "Понижение"} ставок на ${percent}% · ${kws.length} ключей`, `${dir === "up" ? "Increase" : "Decrease"} bids by ${percent}% · ${kws.length} keywords`),
      tool: "adjust_bids",
      changes: kws.slice(0, 8).map((k) => ({ name: k.text, meta: plLabel(k.platform), before: fmtMoney(k.bid), after: fmtMoney(k.bid * factor) })),
      costDaily: dir === "up" ? Math.round((kws.reduce((a, k) => a + k.spend, 0) / 28) * (percent / 100)) : 0,
      apply: () => (lang === "en" ? `bids changed ×${factor.toFixed(2)} across ${kws.length} keywords` : `ставки изменены ×${factor.toFixed(2)} по ${kws.length} ключевым фразам`),
    };
  }

  function createCampaign(name, budget, platform) {
    return {
      kind: "preview",
      title: t(`Создание кампании «${name}» в ${plLabel(platform)}`, `Creating campaign “${name}” on ${plLabel(platform)}`),
      tool: "create_campaign",
      changes: [{ name, meta: t("Будет создана", "Will be created"), after: t(`Бюджет ${fmtMoney(budget)}/день · автостратегия`, `Budget ${fmtMoney(budget)}/day · auto strategy`) }],
      costDaily: budget,
      apply: () => {
        S.campaigns.push({ id: 100 + S.campaigns.length, platform, kind: "campaign", name, status: "active", budget, s7: 0, i7: 0, c7: 0, v7: 0, s28: 0, i28: 0, c28: 0, v28: 0 });
        return lang === "en" ? `campaign “${name}” created on ${plLabel(platform)} and launched` : `кампания «${name}» создана в ${plLabel(platform)} и запущена`;
      },
    };
  }

  function promoteAvito(threshold) {
    const victims = S.campaigns.filter((c) => c.platform === "avito" && c.kind === "listing" && c.status === "active" && c.i7 / 7 < threshold);
    if (!victims.length) return { kind: "text", text: t(`Все активные объявления Авито набирают ≥ ${threshold} просмотров/день — продвижение не требуется.`, `All active Avito listings get ≥ ${threshold} views/day — no promotion needed.`) };
    return {
      kind: "preview",
      title: t(`Продвижение ${victims.length} объявлений с просмотрами ниже ${threshold}/день`, `Promoting ${victims.length} listings below ${threshold} views/day`),
      tool: "promote_low_view_listings",
      changes: victims.map((c) => ({ name: c.name, meta: `${(c.i7 / 7).toFixed(1)} ${t("просмотров/день", "views/day")} · ${fmtMoney(c.price)}`, after: t("Услуга «Поднять в поиске», 7 дней · ≈ 299 ₽/день", "“Boost in search” service, 7 days · ≈ 299 ₽/day") })),
      costDaily: victims.length * 299,
      apply: () => (lang === "en" ? `${victims.length} Avito listings connected to “Boost in search” for 7 days` : `${victims.length} объявлений Авито подключены к услуге «Поднять в поиске» на 7 дней`),
    };
  }

  function applyRecs(ids) {
    const targets = ids ? S.recs.filter((r) => r.status === "open" && ids.includes(r.id)) : S.recs.filter((r) => r.status === "open");
    if (!targets.length) return { kind: "text", text: ids ? t(`Открытой рекомендации ${ids.map((i) => "#" + i).join(", ")} не найдено.`, `Open recommendation ${ids.map((i) => "#" + i).join(", ")} not found.`) : t("Открытых рекомендаций нет — запустите аудит: «Сделай аудит всех кабинетов».", "No open recommendations — run an audit: “Run an audit of all accounts”.") };
    return {
      kind: "preview",
      title: t(`Применение ${targets.length === 1 ? `рекомендации #${targets[0].id}` : `${targets.length} рекомендаций`}`, `Applying ${targets.length === 1 ? `recommendation #${targets[0].id}` : `${targets.length} recommendations`}`),
      tool: "apply_recommendation",
      changes: targets.map((r) => ({ name: r.text, meta: `${plLabel(r.platform)} · #${r.id}`, before: t("Открыта", "Open"), after: t("Будет применена", "Will be applied") })),
      apply: () => {
        for (const r of targets) {
          r.status = "applied";
          if (r.type === "pause" && r.campaignId) { const c = S.campaigns.find((x) => x.id === r.campaignId); if (c) c.status = "paused"; }
          if (r.type === "promote" && r.campaignId) { const c = S.campaigns.find((x) => x.id === r.campaignId); if (c) c.s7 += 100; }
        }
        return lang === "en" ? `${targets.length} recommendation${targets.length > 1 ? "s" : ""} applied` : `применено ${targets.length} рекомендаций`;
      },
    };
  }

  // ── intent parsing (RU + EN, mirrors src/lib/agent/router.ts) ───────────
  function parseIntent(raw) {
    const norm = raw.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    const platforms = [];
    if (/google|гугл|адвордс|adwords/.test(norm)) platforms.push("google");
    if (/яндекс|директ|yandex/.test(norm)) platforms.push("yandex");
    if (/авито|avito/.test(norm)) platforms.push("avito");

    let days = 7;
    const md = norm.match(/(\d{1,3})\s*(?:дн|день|дня|дней|д\.|days?)/);
    if (md) days = Math.min(30, Math.max(1, parseInt(md[1], 10)));
    else if (/месяц|30 дн|month/.test(norm)) days = 30;
    else if (/недел|week/.test(norm)) days = 7;

    const quoted = [];
    const re = /[«"„']([^»"“']{2,60})[»"“']/g;
    let qm;
    while ((qm = re.exec(norm)) !== null) quoted.push(qm[1].trim());

    const T = (tool, extra = {}) => Object.assign({ tool, platforms, days, quoted }, extra);

    if (/минус[-\s]?(фраз|слов|ключ)|negative\s+keyword/.test(norm)) return T("add_negative_keywords");
    if (/рекомендац|recommend/.test(norm) && /(примен|внедри|выполни|запусти|apply)/.test(norm)) {
      const mId = norm.match(/(?:рекомендаци[юи]|recommend(?:ation)?[s]?)\s*#?\s*(\d+)/) || norm.match(/#(\d+)/);
      return T("apply_recommendation", { recId: mId ? parseInt(mId[1], 10) : null, all: !mId && /(все|всё|их|all)/.test(norm) });
    }
    if (/рекомендац|recommend/.test(norm)) return T("list_recommendations");
    if (quoted.length && /(пауз|запуск|запусти|включи|выключи|стопни|останов|pause|resume|enable|disable)/.test(norm)) {
      const toActive = /(запуск|запусти|включ|resume|enable)/.test(norm);
      return T("set_campaign_status", { name: quoted[0], status: toActive ? "active" : "paused" });
    }
    if (/(продвин|продвижени|буст|раскрут|promote)/.test(norm) && /(объявлен|листинг|авито|просмотр|товар|listing)/.test(norm)) {
      const m = norm.match(/(?:просмотр[а-я]*|below|under|views?)\s*(?:ниже|меньше|до|below|under)?\s*(\d+)/);
      return T("promote_low_view_listings", { threshold: m ? parseInt(m[1], 10) : 10, platforms: ["avito"] });
    }
    if (/(пауз|останов|выключ|приостанов|стоп|стопни|отключи|паузь|pause)/.test(norm) && /ctr|кликабельн|клик|click/.test(norm)) {
      const m = norm.match(/(?:ниже|below|under)\s*([\d.,]+)\s*%?/);
      return T("pause_low_ctr_campaigns", { threshold: m ? parseFloat(m[1].replace(",", ".")) : 1.0 });
    }
    if (/(ставк|бид|bid)/.test(norm) && /(подним|увелич|повыс|уменьш|сниз|опуст|измен|скорректир|increase|decrease|raise|lower|adjust)/.test(norm)) {
      const m = norm.match(/(?:на|by)\s*([\d.,]+)\s*%/);
      const percent = m ? Math.min(300, parseFloat(m[1].replace(",", "."))) : 10;
      const down = /(уменьш|сниз|опуст|пониз|минус|decrease|lower|down)/.test(norm);
      return T("adjust_bids", { percent, direction: down ? "down" : "up", filter: /(конверси|конверт|conversions?)/.test(norm) ? "with_conversions" : "all" });
    }
    if (/(создай|создать|запусти новую|новая кампани|create\s+(a\s+)?(new\s+)?campaign)/.test(norm)) {
      const mB = norm.match(/(?:бюджет[а-я]*|budget)\s*(?:of\s+)?(\d[\d\s]{2,9})/) || norm.match(/(\d[\d\s]{2,9})\s*(?:\/?\s*день|\/?\s*per\s*day)/);
      return T("create_campaign", { name: quoted[0] || (lang === "en" ? "New campaign" : "Новая кампания"), budget: mB ? Math.min(500000, parseInt(mB[1].replace(/\s/g, ""), 10)) : 2000, platform: platforms.length === 1 ? platforms[0] : "google" });
    }
    if (/cpa|цену (лида|конверси)/.test(norm) && /(сравни|сравнени|против|лучше|выгодн|эффективнее|compare)/.test(norm)) return T("compare_cpa");
    if (/аудит|диагностик|провер(ь|ка|ить)\s(все|аккаунт|кабинет)|audit|diagnostic/.test(norm)) return T("run_account_audit");
    if (/(чат|лид|сообщени|диалог|chats?|leads?)/.test(norm) && (platforms.includes("avito") || /сводк|summar/.test(norm))) return T("get_avito_chat_summary", { platforms: ["avito"] });
    if (/(ключ|фраз|запрос|keyword)/.test(norm) && /(статист|эффективн|показ|топ|анализ|работ|stats?|performance|show)/.test(norm)) return T("get_keyword_performance");
    if (/(расход|потрач|затрат|отчет|отчёт|сводк|сколько ушло|spend|spent|spending)/.test(norm)) return T("get_spend_report");
    if (/cpa/.test(norm)) return T("compare_cpa");
    if (/(кампани|объявлен|листинг|campaign|listing)/.test(norm) && /(список|покажи|все|какие|статус|что запущено|активн|на паузе|list|show|active|paused|all)/.test(norm)) {
      const status = /на паузе|остановл|paused|pause/.test(norm) ? "paused" : /активн|запущен|active|running/.test(norm) ? "active" : "all";
      return T("list_campaigns", { status });
    }
    if (/(что (ты )?умеешь|помощь|команды|справка|возможности|помоги|help|what can you|commands)/.test(norm)) return T("help");
    return T("fallback");
  }

  const TOOL_LABEL = {
    get_spend_report: () => t("сводный расход по платформам", "total spend by platform"),
    compare_cpa: () => t("сравнение CPA между площадками", "CPA comparison between platforms"),
    list_campaigns: () => t("список кампаний", "campaign list"),
    get_keyword_performance: () => t("статистика по ключевым фразам", "keyword stats"),
    get_avito_chat_summary: () => t("сводка по чатам Авито", "Avito chats summary"),
    run_account_audit: () => t("автоматический аудит кабинетов", "automated account audit"),
    pause_low_ctr_campaigns: () => t("пауза кампаний с низким CTR", "pause low-CTR campaigns"),
    set_campaign_status: () => t("пауза/запуск кампании", "pause/resume campaign"),
    adjust_bids: () => t("корректировка ставок", "bid adjustment"),
    create_campaign: () => t("создание кампании", "create campaign"),
    promote_low_view_listings: () => t("продвижение объявлений Авито", "promote Avito listings"),
    add_negative_keywords: () => t("добавление минус-фраз", "add negative keywords"),
    list_recommendations: () => t("список рекомендаций", "recommendations list"),
    apply_recommendation: () => t("применение рекомендаций", "apply recommendations"),
    help: () => t("справка", "help"),
    fallback: () => t("уточнение запроса", "clarify request"),
  };

  const WRITE_TOOLS = new Set(["pause_low_ctr_campaigns", "set_campaign_status", "adjust_bids", "create_campaign", "promote_low_view_listings", "apply_recommendation"]);

  const trace = (label, detail, status) => ({ label, detail, status });

  // ── main entry: runAgent ────────────────────────────────────────────────
  function runAgent(raw) {
    const i = parseIntent(raw);
    const tr = [
      trace(lang === "en" ? `AI Core: intent recognized → ${i.tool}` : `AI Core: намерение распознано → ${i.tool}`, TOOL_LABEL[i.tool](), "ok"),
      trace(lang === "en" ? `Routing to adapters: ${(i.platforms.length ? i.platforms : ["google", "yandex", "avito"]).map((p) => plLabel(p)).join(", ")}` : `Маршрутизация адаптерам: ${(i.platforms.length ? i.platforms : ["google", "yandex", "avito"]).map((p) => plLabel(p)).join(", ")}`, lang === "en" ? "sandbox mode: local mirror data" : "sandbox-режим: данные из локального зеркала", "ok"),
    ];
    let card, content;
    let pendingId;

    const P = () => tr.push(trace(lang === "en" ? "Safety layer: dry-run enabled → preview prepared" : "Safety-слой: dry-run включён → подготовлен предпросмотр", lang === "en" ? "Changes are not applied without explicit confirmation" : "Изменения не применяются без явного подтверждения", "warn"));
    const P2 = () => tr.push(trace(lang === "en" ? "Safety layer: confirmation required (affects budget)" : "Safety-слой: требуется подтверждение (влияет на бюджет)", "", "warn"));

    const dispatch = () => {
      switch (i.tool) {
        case "get_spend_report": {
          card = spendReport(i.days, i.platforms);
          content = lang === "en" ? `Done: total spend ${DemoAgent.fmtMoney(card.total.spend)} for ${i.days} days.` : `Готово: суммарный расход ${fmtMoney(card.total.spend)} за ${i.days} дн.`;
          content += advisorNote(card.rows);
          break;
        }
        case "compare_cpa":
          card = compareCpa(i.days, i.platforms);
          content = card.kind === "cpa" ? card.insight : card.text;
          break;
        case "list_campaigns": {
          card = listCampaigns(i.status);
          content = lang === "en" ? `Found ${card.rows.length} campaigns and listings.` : `Найдено ${card.rows.length} кампаний и объявлений.`;
          break;
        }
        case "get_keyword_performance":
          card = keywordStats();
          content = lang === "en" ? `Collected stats for ${card.rows.length} keywords.` : `Собрал статистику по ${card.rows.length} ключевым фразам.`;
          break;
        case "get_avito_chat_summary": {
          card = chatSummary();
          content = lang === "en" ? `Chats summary: ${card.total} dialogs, ${card.leads} of them are leads.` : `Сводка по чатам: ${card.total} диалогов, из них ${card.leads} лидов.`;
          break;
        }
        case "run_account_audit": {
          card = runAudit();
          content = lang === "en" ? `Audit finished, overall score ${card.score}/100.` : `Аудит завершён, итоговая оценка ${card.score}/100.`;
          break;
        }
        case "list_recommendations": {
          card = listRecs();
          content = lang === "en" ? `Open recommendations: ${card.rows.length}.` : `Открытых рекомендаций: ${card.rows.length}.`;
          break;
        }
        case "pause_low_ctr_campaigns": {
          const p = pauseLowCtr(i.threshold);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение."; P(); pendingId = pendingAction(i.tool, {}, p, 0); card.pendingActionId = pendingId; }
          break;
        }
        case "set_campaign_status": {
          const p = setStatus(i.name, i.status, i.platforms[0]);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение."; P2(); pendingId = pendingAction(i.tool, {}, p, p.costDaily || 0); card.pendingActionId = pendingId; }
          break;
        }
        case "adjust_bids": {
          const p = adjustBids(i.percent, i.direction, i.filter);
          card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение.";
          P2(); pendingId = pendingAction(i.tool, {}, p, p.costDaily || 0); card.pendingActionId = pendingId;
          break;
        }
        case "create_campaign": {
          const p = createCampaign(i.name, i.budget, i.platform);
          card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение.";
          tr.push(trace(lang === "en" ? "Limits: daily limit 50,000 ₽ check → headroom available" : "Лимиты: проверка дневного лимита 50 000 ₽ → запас есть", "", "ok"));
          P2(); pendingId = pendingAction(i.tool, {}, p, p.costDaily); card.pendingActionId = pendingId;
          break;
        }
        case "promote_low_view_listings": {
          const p = promoteAvito(i.threshold);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение."; P2(); pendingId = pendingAction(i.tool, {}, p, p.costDaily); card.pendingActionId = pendingId; }
          break;
        }
        case "apply_recommendation": {
          const p = applyRecs(i.recId ? [i.recId] : null);
          if (p.kind === "text") { card = p; content = p.text; }
          else { card = p; content = lang === "en" ? "Change preview is ready — confirm to apply." : "Предпросмотр изменений готов — подтвердите выполнение."; P2(); pendingId = pendingAction(i.tool, {}, p, 0); card.pendingActionId = pendingId; }
          break;
        }
        case "add_negative_keywords":
          if (i.quoted.length) {
            card = { kind: "text", text: lang === "en" ? `Negative keywords “${i.quoted.join(", ")}” — a write operation: in the full product they are added to the search campaign after confirmation. In the demo apply them via “Apply all recommendations”.` : `Минус-фразы «${i.quoted.join(", ")}» — write-операция: в полной версии они добавляются в поисковую кампанию после подтверждения. В демо применяйте их через «Примени все рекомендации».` };
            content = lang === "en" ? `Got it: ${i.quoted.map((w) => `“${w}”`).join(", ")}.` : `Принял: ${i.quoted.map((w) => `«${w}»`).join(", ")}.`;
          } else {
            card = { kind: "text", text: lang === "en" ? "Quote the phrases, e.g. “used, repair”." : "Укажите минус-фразы в кавычках, например: «б/у, ремонт»." };
            content = lang === "en" ? "Quote the phrases, e.g. “used, repair”." : "Укажите минус-фразы в кавычках.";
          }
          break;
        case "help":
          card = { kind: "help" };
          content = lang === "en" ? "I understand commands in natural language. Try:" : "Я понимаю команды на естественном языке. Попробуйте:";
          break;
        default:
          card = { kind: "text", text: lang === "en" ? "Couldn't recognize the command. Try: “Show spend for the last 7 days”, “Pause campaigns with CTR below 1%” or “help”." : "Не смог распознать команду. Попробуйте: «Покажи расходы за последние 7 дней», «Поставь на паузу кампании с CTR ниже 1%» или «помощь»." };
          content = lang === "en" ? "Couldn't recognize the command." : "Не смог распознать команду.";
      }
    };
    dispatch();

    const isWrite = WRITE_TOOLS.has(i.tool) && card.kind === "preview";
    tr.push(isWrite ? trace(lang === "en" ? "Result stored, awaiting confirmation" : "Результат записан, ожидает подтверждения", "", "ok") : trace(lang === "en" ? "Result aggregated and returned" : "Результат агрегирован и возвращён", "", "ok"));
    if (!isWrite) audit(i.tool, "ok", content.slice(0, 90), i.platforms);

    return { content, card, trace: tr, pendingId };
  }

  function resolvePending(id, decision) {
    if (!S.pending || S.pending.id !== id) return { content: t("Это действие уже обработано ранее — проверьте журнал аудита.", "This action was already processed earlier — check the audit log."), card: null, trace: [] };
    const p = S.pending;
    S.pending = null;
    if (decision === "reject") {
      audit(p.tool, "rejected", lang === "en" ? `Rejected by user: ${p.tool} #${id}` : `Отклонено пользователем: ${p.tool} #${id}`, []);
      return { content: t("Action cancelled — changes were not applied. Logged to the audit log.", "Отменил действие — изменения не применены. Записал в журнал аудита."), card: null, trace: [trace(lang === "en" ? `Confirmation #${id}: rejected by user` : `Подтверждение #${id}: отклонено пользователем`, "", "warn")] };
    }
    const summary = p.preview.apply();
    audit(p.tool, "applied", summary, []);
    return {
      content: t(`Done: ${summary}. All changes are fixed in the audit log.`, `Выполнено: ${summary}. Все изменения зафиксированы в журнале аудита.`),
      card: null,
      trace: [
        trace(lang === "en" ? `Confirmation #${id} received` : `Подтверждение #${id} получено`, "", "ok"),
        trace(lang === "en" ? "Local mirror updated" : "Локальное зеркало обновлено", summary, "ok"),
        trace(lang === "en" ? "Adapters: sandbox mode — changes stored locally" : "Адаптеры: sandbox-режим — изменения записаны локально", "", "ok"),
        trace(lang === "en" ? "Audit log entry created" : "Запись в audit-log создана", "", "ok"),
      ],
    };
  }

  function getAudit() { return S.audit; }
  function getPending() { return S.pending; }

  return { runAgent, resolvePending, getAudit, getPending, reset, parseIntent, fmtMoney, setLang, getLang };
})();
