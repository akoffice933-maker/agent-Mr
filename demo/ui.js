// Demo UI: chat rendering, side panels, i18n toggle. Loaded after data.js, i18n.js, agent.js.
(function () {
  const body = document.getElementById("chatBody");
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const chipsBox = document.getElementById("chips");
  const tracePanel = document.getElementById("tracePanel");
  const auditPanel = document.getElementById("auditPanel");
  const langBtn = document.getElementById("langBtn");

  let lang = localStorage.getItem("agentmr_lang") === "en" ? "en" : "ru";
  DemoAgent.setLang(lang);
  const L = () => I18N[lang];
  const t = (k) => (L()[k] !== undefined ? L()[k] : k);
  const t2 = (ru, en) => (lang === "en" ? en : ru);
  const plLabel = (p) => (lang === "en" ? PLATFORM_LABEL_EN[p] : PLATFORM_LABEL[p]);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU").format(n);
  const pct = (n, d = 2) => new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU", { maximumFractionDigits: d }).format(n) + "%";
  const money = (n) => DemoAgent.fmtMoney(n);
  const platformDot = (p) => `<span class="pdot" style="background:${PLATFORM_COLOR[p]}"></span>`;

  // ── i18n apply ──────────────────────────────────────────────────────────
  function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = L()[el.dataset.i18n];
      if (v !== undefined) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const v = L()[el.dataset.i18nPh];
      if (v !== undefined) el.placeholder = v;
    });
    langBtn.textContent = lang === "ru" ? "EN" : "RU";
  }

  function setLang(l) {
    lang = l === "en" ? "en" : "ru";
    localStorage.setItem("agentmr_lang", lang);
    DemoAgent.setLang(lang);
    DemoAgent.reset();
    applyI18n();
    renderChips();
    body.innerHTML = "";
    addAgentMsg(greeting());
    renderAudit();
    tracePanel.innerHTML = `<div class="hint" data-i18n="side.traceHint">${t("side.traceHint")}</div>`;
  }

  function greeting() {
    return {
      content: lang === "en"
        ? "Hi! I'm the Unified AI Ads Agent — I run ads on Google Ads, Yandex Direct and Avito from a single window. This is an interactive demo on the seed data of the “Romashka Furniture” account: 6 Google campaigns, 6 Yandex, 8 Avito listings, 28 days of metrics. Type commands in English or Russian — e.g. “Show spend for the last 7 days”. All changes go through the safety layer: dry-run, spend limits and confirmation."
        : "Привет! Я Unified AI Ads Agent — управляю рекламой в Google Ads, Яндекс.Директе и на Авито из одного окна. Это интерактивное демо на seed-данных кабинета «Ромашка Мебель»: 6 кампаний Google, 6 Директа, 8 объявлений Авито, 28 дней метрик. Пишите команды на русском или английском — например, «Покажи расходы за последние 7 дней». Все изменения проходят через safety-слой: dry-run, лимиты и подтверждения.",
      card: null,
      trace: [],
      pendingId: null,
    };
  }

  // ── card renderers ──────────────────────────────────────────────────────
  function renderCard(card) {
    if (!card) return "";
    switch (card.kind) {
      case "spend": {
        const rows = card.rows.map((r) => `
          <tr>
            <td>${platformDot(r.platform)}${plLabel(r.platform)}</td>
            <td class="num">${money(r.s)}</td>
            <td class="num">${num(Math.round(r.i))}</td>
            <td class="num">${num(Math.round(r.k))}</td>
            <td class="num">${r.ctr ? pct(r.ctr) : "—"}</td>
            <td class="num">${r.cpa ? money(r.cpa) : "—"}</td>
            <td class="num">${r.campaigns}</td>
          </tr>`).join("");
        return `<div class="card"><h4>${t2("Расход за", "Spend for")} ${card.days} ${t2("дн.", "days")}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t2("Платформа", "Platform")}</th><th class="num">${t2("Расход", "Spend")}</th><th class="num">${t2("Показы", "Impressions")}</th><th class="num">${t2("Клики", "Clicks")}</th><th class="num">CTR</th><th class="num">CPA</th><th class="num">${t2("Камп.", "Camps.")}</th></tr></thead>
          <tbody>${rows}
          <tr class="total-row"><td>${t2("Итого", "Total")}</td><td class="num">${money(card.total.spend)}</td><td class="num" colspan="5"></td></tr>
          </tbody></table></div></div>`;
      }
      case "cpa": {
        const rows = card.rows.map((r) => `
          <tr>
            <td>${platformDot(r.platform)}${plLabel(r.platform)}</td>
            <td class="num">${money(r.s)}</td>
            <td class="num">${num(Math.round(r.v))}</td>
            <td class="num">${r.cpa ? money(r.cpa) : "—"}</td>
          </tr>`).join("");
        return `<div class="card"><h4>CPA · ${card.days} ${t2("дн.", "days")}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t2("Платформа", "Platform")}</th><th class="num">${t2("Расход", "Spend")}</th><th class="num">${t2("Конверсии", "Conversions")}</th><th class="num">CPA</th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`;
      }
      case "campaigns": {
        const rows = card.rows.map((c) => {
          const ctr = c.i > 0 ? pct((c.k / c.i) * 100) : "—";
          const cpa = c.v > 0 ? money(c.s / c.v) : "—";
          return `<tr>
            <td>${platformDot(c.platform)}${esc(c.name)}<br><span class="tag ${c.status}">${c.status === "active" ? t2("активна", "active") : t2("пауза", "paused")}</span></td>
            <td class="num">${money(c.budget)}/day</td>
            <td class="num">${money(c.s)}</td>
            <td class="num">${ctr}</td>
            <td class="num">${cpa}</td>
          </tr>`;
        }).join("");
        return `<div class="card"><h4>${t2("Кампании и объявления (7 дней) · статус:", "Campaigns & listings (7 days) · status:")} ${card.status === "all" ? t2("все", "all") : card.status}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t2("Название", "Name")}</th><th class="num">${t2("Бюджет", "Budget")}</th><th class="num">${t2("Расход", "Spend")}</th><th class="num">CTR</th><th class="num">CPA</th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`;
      }
      case "keywords": {
        const rows = card.rows.map((k) => `
          <tr>
            <td>${platformDot(k.platform)}${esc(k.text)}</td>
            <td class="num">${money(k.bid)}</td>
            <td class="num">${num(k.clicks)}</td>
            <td class="num">${k.conv}</td>
            <td class="num">${k.conv ? money(k.spend / k.conv) : "—"}</td>
            <td class="num">${money(k.spend)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>${t2("Топ ключевых фраз по расходу", "Top keywords by spend")}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t2("Ключ", "Keyword")}</th><th class="num">${t2("Ставка", "Bid")}</th><th class="num">${t2("Клики", "Clicks")}</th><th class="num">${t2("Конв.", "Conv.")}</th><th class="num">CPA</th><th class="num">${t2("Расход", "Spend")}</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <div class="cost-note">${t2("Ключи без конверсий — кандидаты на минус-фразы или понижение ставки.", "Keywords without conversions are candidates for negative keywords or bid reduction.")}</div></div>`;
      }
      case "chats": {
        const rows = card.rows.map((c) => `
          <tr>
            <td>${esc(c.customer)}</td>
            <td><span class="tag ${c.status === "lead" ? "active" : "paused"}">${c.status === "lead" ? t2("лид", "lead") : c.status === "consult" ? t2("консультация", "consult") : c.status === "new" ? t2("новый", "new") : t2("закрыт", "closed")}</span></td>
            <td class="num">${c.msgs}</td>
            <td style="color:var(--fog)">${esc(c.last)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>${t2("Чаты Авито:", "Avito chats:")} ${card.total} ${t2("диалогов, ", "dialogs, ")}${card.leads} ${t2("лидов", "leads")}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t2("Клиент", "Client")}</th><th>${t2("Статус", "Status")}</th><th class="num">${t2("Сообщений", "Messages")}</th><th>${t2("Последнее сообщение", "Last message")}</th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`;
      }
      case "audit": {
        const blocks = Object.entries(card.issues).filter(([, v]) => v.length).map(([p, list]) => `
          <div style="margin-bottom:10px">
            <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${platformDot(p)}${plLabel(p)}</div>
            ${list.map((i) => `<div style="font-size:12.5px;color:var(--mist);padding:3px 0 3px 15px">• <span style="color:${i.sev === "high" ? "var(--bad)" : i.sev === "medium" ? "var(--warn)" : "var(--fog)"}">[${i.sev}]</span> ${esc(i.text)}</div>`).join("")}
          </div>`).join("");
        return `<div class="card"><h4>${t2("Итоговая оценка:", "Overall score:")} ${card.score}/100</h4>${blocks}</div>`;
      }
      case "recs": {
        const rows = card.rows.map((r) => `
          <tr>
            <td class="num">#${r.id}</td>
            <td>${platformDot(r.platform)}${esc(r.text)}</td>
            <td style="color:var(--accent)">${esc(r.impact)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>${t2("Открытые рекомендации", "Open recommendations")}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num">#</th><th>${t2("Описание", "Description")}</th><th>${t2("Эффект", "Impact")}</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <div class="cost-note">${t2("Скажите «Примени все рекомендации» (или «Примени рекомендацию 22») для подтверждения.", "Say “Apply all recommendations” (or “Apply recommendation 22”) to confirm.")}</div></div>`;
      }
      case "preview": {
        const changes = card.changes.map((c) => `
          <div class="change">
            <div class="cname">${esc(c.name)}</div>
            ${c.meta ? `<div class="cmeta">${esc(c.meta)}</div>` : ""}
            ${c.after ? `<div class="cafter">${c.before ? esc(c.before) + " → " : ""}${esc(c.after)}</div>` : ""}
          </div>`).join("");
        const cost = card.costDaily > 0 ? `<div class="cost-note">≈ +${money(card.costDaily)}/day ${t2("к расходу · лимиты проверены", "to spend · limits checked")}</div>` : "";
        return `<div class="card"><h4>⏳ ${esc(card.title)}</h4>${changes}${cost}
          <div class="preview-actions">
            <button class="pv-btn ok" data-pv="${card.pendingActionId}" data-dec="approve">${t2("✅ Подтвердить", "✅ Approve")}</button>
            <button class="pv-btn" data-pv="${card.pendingActionId}" data-dec="reject">${t2("❌ Отклонить", "❌ Reject")}</button>
          </div></div>`;
      }
      case "help": {
        return `<div class="card"><h4>${t2("Что я умею", "What I can do")}</h4>
          <div style="font-size:12.5px;color:var(--mist);line-height:1.9">
            ${lang === "en" ? `• “Show spend for the last 7 days”<br>
            • “Compare CPA between Google Ads and Yandex Direct”<br>
            • “List active campaigns” / “paused campaigns”<br>
            • “Pause campaigns with CTR below 1%”<br>
            • “Pause “Search — Sofas to order””<br>
            • “Increase bids by 10% on keywords with conversions”<br>
            • “Create a campaign in Yandex with a budget of 3000”<br>
            • “Promote Avito listings with low reach”<br>
            • “Avito chats summary”<br>
            • “Run an audit of all accounts”<br>
            • “Show recommendations” / “Apply all recommendations”<br>
            • “Keyword performance stats”` : `• «Покажи расходы по всем площадкам за последние 7 дней»<br>
            • «Сравни CPA между Google Ads и Яндекс.Директом»<br>
            • «Покажи активные кампании» / «кампании на паузе»<br>
            • «Поставь на паузу кампании с CTR ниже 1%»<br>
            • «Поставь на паузу «Поиск — Диваны на заказ»»<br>
            • «Подними ставки на 10% по ключам с конверсиями»<br>
            • «Создай кампанию в Директе с бюджетом 3000»<br>
            • «Продвинь объявления Авито с низким охватом»<br>
            • «Сводка по чатам Авито»<br>
            • «Сделай аудит всех кабинетов»<br>
            • «Покажи рекомендации» / «Примени все рекомендации»<br>
            • «Статистика по ключевым фразам»`}
          </div>
          <div class="cost-note">${t2("Все операции записи проходят safety-слой: dry-run, лимиты бюджета и подтверждение.", "All write operations pass the safety layer: dry-run, spend limits and confirmation.")}</div></div>`;
      }
      default:
        return `<div class="card">${esc(card.text)}</div>`;
    }
  }

  // ── messages ────────────────────────────────────────────────────────────
  function scrollDown() { body.scrollTop = body.scrollHeight; }

  function addUserMsg(text) {
    const div = document.createElement("div");
    div.className = "msg user";
    div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    body.appendChild(div);
    scrollDown();
  }

  function addAgentMsg({ content, card, trace, pendingId }) {
    const div = document.createElement("div");
    div.className = "msg agent";
    const traceHtml = trace && trace.length ? `
      <details class="trace" open>
        <summary>trace · ${trace.length} ${t2("шагов", "steps")}</summary>
        ${trace.map((t) => `<div class="trace-step"><span class="dot ${t.status}"></span><span>${esc(t.label)}${t.detail ? ` — ${esc(t.detail)}` : ""}</span></div>`).join("")}
      </details>` : "";
    div.innerHTML = `<div class="bubble">${esc(content)}${renderCard(card)}${traceHtml}</div>
      <div class="meta">${new Date().toLocaleTimeString(lang === "en" ? "en-GB" : "ru-RU", { hour: "2-digit", minute: "2-digit" })} · ${pendingId ? t2(`действие #${pendingId} ожидает подтверждения`, `action #${pendingId} awaiting confirmation`) : t2("операция чтения", "read operation")}</div>`;
    body.appendChild(div);
    wirePreviewButtons(div);
    scrollDown();
    renderTrace(trace);
  }

  function wirePreviewButtons(root) {
    root.querySelectorAll(".pv-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.pv);
        const dec = btn.dataset.dec;
        root.querySelectorAll(".pv-btn").forEach((b) => (b.disabled = true));
        const res = DemoAgent.resolvePending(id, dec === "approve" ? "approve" : "reject");
        setTimeout(() => addAgentMsg(res), 350);
        renderAudit();
      });
    });
  }

  function renderTrace(traceList) {
    tracePanel.innerHTML = "";
    if (!traceList || !traceList.length) return;
    for (const t of traceList) {
      const d = document.createElement("div");
      d.className = "audit-item";
      d.innerHTML = `<div class="a-top"><span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${t.status === "ok" ? "var(--good)" : t.status === "warn" ? "var(--warn)" : "var(--bad)"}"></span>
        <span class="a-sum" style="font-size:12px">${esc(t.label)}</span></div>
        ${t.detail ? `<div class="a-sum" style="color:var(--fog);font-size:11px;padding-left:15px">${esc(t.detail)}</div>` : ""}`;
      tracePanel.appendChild(d);
    }
  }

  function renderAudit() {
    auditPanel.innerHTML = "";
    const items = DemoAgent.getAudit();
    if (!items.length) { auditPanel.innerHTML = `<div class="hint">${t("side.auditEmpty")}</div>`; return; }
    for (const a of items.slice(0, 12)) {
      const d = document.createElement("div");
      d.className = "audit-item";
      d.innerHTML = `<div class="a-top"><span class="a-tool">${esc(a.tool)}</span><span class="a-status ${a.status}">${a.status}</span><span class="a-ts">${a.ts}</span></div>
        <div class="a-sum">${esc(a.summary)}</div>`;
      auditPanel.appendChild(d);
    }
  }

  // ── agent turn ──────────────────────────────────────────────────────────
  let busy = false;
  function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    addUserMsg(text);

    const typing = document.createElement("div");
    typing.className = "msg agent";
    typing.innerHTML = '<div class="bubble typing"><i></i><i></i><i></i></div>';
    body.appendChild(typing);
    scrollDown();

    setTimeout(() => {
      typing.remove();
      const res = DemoAgent.runAgent(text);
      addAgentMsg(res);
      renderAudit();
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }, 550);
  }

  // ── chips ───────────────────────────────────────────────────────────────
  function renderChips() {
    chipsBox.innerHTML = "";
    for (const c of CHIPS_I18N[lang]) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = c;
      b.addEventListener("click", () => send(c));
      chipsBox.appendChild(b);
    }
  }

  // ── init ────────────────────────────────────────────────────────────────
  langBtn.addEventListener("click", () => setLang(lang === "ru" ? "en" : "ru"));
  applyI18n();
  renderChips();
  addAgentMsg(greeting());
  sendBtn.addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });
})();
