// Demo UI: chat rendering + side panels. Loaded after data.js and agent.js.
(function () {
  const body = document.getElementById("chatBody");
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const chipsBox = document.getElementById("chips");
  const tracePanel = document.getElementById("tracePanel");
  const auditPanel = document.getElementById("auditPanel");

  const CHIPS = [
    "Покажи расходы за последние 7 дней",
    "Сравни CPA между Google Ads и Яндекс.Директом",
    "Покажи активные кампании",
    "Поставь на паузу кампании с CTR ниже 1%",
    "Сделай аудит всех кабинетов",
    "Покажи рекомендации",
    "Сводка по чатам Авито",
  ];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function platformDot(p) {
    return `<span class="pdot" style="background:${PLATFORM_COLOR[p]}"></span>`;
  }

  // ── card renderers ──────────────────────────────────────────────────────
  function renderCard(card) {
    if (!card) return "";
    switch (card.kind) {
      case "spend": {
        const rows = card.rows.map((r) => `
          <tr>
            <td>${platformDot(r.platform)}${PLATFORM_LABEL[r.platform]}</td>
            <td class="num">${DemoAgent.fmtMoney(r.s)}</td>
            <td class="num">${new Intl.NumberFormat("ru-RU").format(Math.round(r.i))}</td>
            <td class="num">${new Intl.NumberFormat("ru-RU").format(Math.round(r.k))}</td>
            <td class="num">${r.ctr ? DemoAgent.fmtMoney ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(r.ctr) + "%" : "" : "—"}</td>
            <td class="num">${r.cpa ? DemoAgent.fmtMoney(r.cpa) : "—"}</td>
            <td class="num">${r.campaigns}</td>
          </tr>`).join("");
        return `<div class="card"><h4>Расход за ${card.days} дн.</h4>
          <table class="tbl"><thead><tr><th>Платформа</th><th class="num">Расход</th><th class="num">Показы</th><th class="num">Клики</th><th class="num">CTR</th><th class="num">CPA</th><th class="num">Камп.</th></tr></thead>
          <tbody>${rows}
          <tr class="total-row"><td>Итого</td><td class="num">${DemoAgent.fmtMoney(card.total.spend)}</td><td class="num" colspan="5"></td></tr>
          </tbody></table></div>`;
      }
      case "cpa": {
        const rows = card.rows.map((r) => `
          <tr>
            <td>${platformDot(r.platform)}${PLATFORM_LABEL[r.platform]}</td>
            <td class="num">${DemoAgent.fmtMoney(r.s)}</td>
            <td class="num">${new Intl.NumberFormat("ru-RU").format(Math.round(r.v))}</td>
            <td class="num">${r.cpa ? DemoAgent.fmtMoney(r.cpa) : "—"}</td>
          </tr>`).join("");
        return `<div class="card"><h4>CPA за ${card.days} дн.</h4>
          <table class="tbl"><thead><tr><th>Платформа</th><th class="num">Расход</th><th class="num">Конверсии</th><th class="num">CPA</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
      }
      case "campaigns": {
        const rows = card.rows.map((c) => {
          const ctr = c.i > 0 ? ((c.k / c.i) * 100).toFixed(2) + "%" : "—";
          const cpa = c.v > 0 ? DemoAgent.fmtMoney(c.s / c.v) : "—";
          return `<tr>
            <td>${platformDot(c.platform)}${esc(c.name)}<br><span class="tag ${c.status}">${c.status === "active" ? "активна" : "пауза"}</span></td>
            <td class="num">${DemoAgent.fmtMoney(c.budget)}/д</td>
            <td class="num">${DemoAgent.fmtMoney(c.s)}</td>
            <td class="num">${ctr}</td>
            <td class="num">${cpa}</td>
          </tr>`;
        }).join("");
        return `<div class="card"><h4>Кампании и объявления (7 дней) · статус: ${card.status === "all" ? "все" : card.status}</h4>
          <table class="tbl"><thead><tr><th>Название</th><th class="num">Бюджет</th><th class="num">Расход</th><th class="num">CTR</th><th class="num">CPA</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
      }
      case "keywords": {
        const rows = card.rows.map((k) => `
          <tr>
            <td>${platformDot(k.platform)}${esc(k.text)}</td>
            <td class="num">${DemoAgent.fmtMoney(k.bid)}</td>
            <td class="num">${new Intl.NumberFormat("ru-RU").format(k.clicks)}</td>
            <td class="num">${k.conv}</td>
            <td class="num">${k.conv ? DemoAgent.fmtMoney(k.spend / k.conv) : "—"}</td>
            <td class="num">${DemoAgent.fmtMoney(k.spend)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>Топ ключевых фраз по расходу</h4>
          <table class="tbl"><thead><tr><th>Ключ</th><th class="num">Ставка</th><th class="num">Клики</th><th class="num">Конв.</th><th class="num">CPA</th><th class="num">Расход</th></tr></thead>
          <tbody>${rows}</tbody></table>
          <div class="cost-note">Ключи без конверсий — кандидаты на минус-фразы или понижение ставки.</div></div>`;
      }
      case "chats": {
        const rows = card.rows.map((c) => `
          <tr>
            <td>${esc(c.customer)}</td>
            <td><span class="tag ${c.status === "lead" ? "active" : "paused"}">${c.status === "lead" ? "лид" : c.status === "consult" ? "консультация" : c.status === "new" ? "новый" : "закрыт"}</span></td>
            <td class="num">${c.msgs}</td>
            <td style="color:var(--fog)">${esc(c.last)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>Чаты Авито: ${card.total} диалогов, ${card.leads} лидов</h4>
          <table class="tbl"><thead><tr><th>Клиент</th><th>Статус</th><th class="num">Сообщений</th><th>Последнее сообщение</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
      }
      case "audit": {
        const blocks = Object.entries(card.issues).filter(([, v]) => v.length).map(([p, list]) => `
          <div style="margin-bottom:10px">
            <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${platformDot(p)}${PLATFORM_LABEL[p]}</div>
            ${list.map((i) => `<div style="font-size:12.5px;color:var(--mist);padding:3px 0 3px 15px">• <span style="color:${i.sev === "high" ? "var(--bad)" : i.sev === "medium" ? "var(--warn)" : "var(--fog)"}">[${i.sev}]</span> ${esc(i.text)}</div>`).join("")}
          </div>`).join("");
        return `<div class="card"><h4>Итоговая оценка: ${card.score}/100</h4>${blocks}</div>`;
      }
      case "recs": {
        const rows = card.rows.map((r) => `
          <tr>
            <td class="num">#${r.id}</td>
            <td>${platformDot(r.platform)}${esc(r.text)}</td>
            <td style="color:var(--accent)">${esc(r.impact)}</td>
          </tr>`).join("");
        return `<div class="card"><h4>Открытые рекомендации</h4>
          <table class="tbl"><thead><tr><th class="num">#</th><th>Описание</th><th>Эффект</th></tr></thead>
          <tbody>${rows}</tbody></table>
          <div class="cost-note">Скажите «Примени все рекомендации» (или «Примени рекомендацию 22») для подтверждения.</div></div>`;
      }
      case "preview": {
        const changes = card.changes.map((c) => `
          <div class="change">
            <div class="cname">${esc(c.name)}</div>
            ${c.meta ? `<div class="cmeta">${esc(c.meta)}</div>` : ""}
            ${c.after ? `<div class="cafter">${c.before ? esc(c.before) + " → " : ""}${esc(c.after)}</div>` : ""}
          </div>`).join("");
        const cost = card.costDaily > 0 ? `<div class="cost-note">≈ +${DemoAgent.fmtMoney(card.costDaily)}/день к расходу · лимиты проверены</div>` : "";
        return `<div class="card"><h4>⏳ ${esc(card.title)}</h4>${changes}${cost}
          <div class="preview-actions">
            <button class="pv-btn ok" data-pv="${card.pendingActionId}" data-dec="approve">✅ Подтвердить</button>
            <button class="pv-btn" data-pv="${card.pendingActionId}" data-dec="reject">❌ Отклонить</button>
          </div></div>`;
      }
      case "help": {
        return `<div class="card"><h4>Что я умею</h4>
          <div style="font-size:12.5px;color:var(--mist);line-height:1.9">
            • «Покажи расходы по всем площадкам за последние 7 дней»<br>
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
            • «Статистика по ключевым фразам»
          </div>
          <div class="cost-note">Все операции записи проходят safety-слой: dry-run, лимиты бюджета и подтверждение.</div></div>`;
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
        <summary>trace · ${trace.length} шагов</summary>
        ${trace.map((t) => `<div class="trace-step"><span class="dot ${t.status}"></span><span>${esc(t.label)}${t.detail ? ` — ${esc(t.detail)}` : ""}</span></div>`).join("")}
      </details>` : "";
    div.innerHTML = `<div class="bubble">${esc(content)}${renderCard(card)}${traceHtml}</div>
      <div class="meta">${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · ${pendingId ? `действие #${pendingId} ожидает подтверждения` : "операция чтения"}</div>`;
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

  function renderTrace(trace) {
    tracePanel.innerHTML = "";
    if (!trace || !trace.length) return;
    for (const t of trace) {
      const d = document.createElement("div");
      d.className = "audit-item";
      d.innerHTML = `<div class="a-top"><span class="dot ${t.status}" style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${t.status === "ok" ? "var(--good)" : t.status === "warn" ? "var(--warn)" : "var(--bad)"}"></span>
        <span class="a-sum" style="font-size:12px">${esc(t.label)}</span></div>
        ${t.detail ? `<div class="a-sum" style="color:var(--fog);font-size:11px;padding-left:15px">${esc(t.detail)}</div>` : ""}`;
      tracePanel.appendChild(d);
    }
  }

  function renderAudit() {
    auditPanel.innerHTML = "";
    const items = DemoAgent.getAudit();
    if (!items.length) { auditPanel.innerHTML = '<div class="hint">Журнал пуст — начните с любой команды.</div>'; return; }
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

  // ── init ────────────────────────────────────────────────────────────────
  for (const c of CHIPS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.addEventListener("click", () => send(c));
    chipsBox.appendChild(b);
  }

  addAgentMsg({
    content: "Привет! Я Unified AI Ads Agent — управляю рекламой в Google Ads, Яндекс.Директе и на Авито из одного окна. Это интерактивное демо на seed-данных кабинета «Ромашка Мебель»: 6 кампаний Google, 6 Директа, 8 объявлений Авито, 28 дней метрик. Пишите команды на русском — например, «Покажи расходы за последние 7 дней». Все изменения проходят через safety-слой: dry-run, лимиты и подтверждения.",
    card: null,
    trace: [],
    pendingId: null,
  });

  sendBtn.addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });
})();
