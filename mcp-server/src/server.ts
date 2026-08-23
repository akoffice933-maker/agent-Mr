// MCP server core for Unified AI Ads Agent (ТЗ этап 7, US-7).
// Exposes unified commands as MCP tools and proxies them to the agent's REST API.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface AgentMrServerOptions {
  apiUrl?: string;
  apiKey?: string;
}

export function createAgentMrServer(opts: AgentMrServerOptions = {}): Server {
  const API = opts.apiUrl ?? process.env.AGENT_API_URL ?? "http://localhost:3000";
  const API_KEY = opts.apiKey ?? process.env.AGENT_API_KEY ?? "";

  async function api(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Agent API ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  function textResult(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  interface PendingRow {
    id: number;
    tool: string;
    status: string;
    createdAt: string;
    costDaily: number | null;
    preview?: { title?: string; changes?: { name: string; before?: string; after?: string }[] };
  }

  function describePending(d: PendingRow): string {
    const lines = [`#${d.id} · ${d.tool} · ${d.status} (${new Date(d.createdAt).toLocaleString("ru-RU")})`];
    if (d.preview?.title) lines.push(d.preview.title);
    for (const c of d.preview?.changes ?? []) lines.push(`  • ${c.name}: ${c.before ?? ""} → ${c.after ?? ""}`);
    if (d.costDaily) lines.push(`≈ +${d.costDaily} ₽/день`);
    return lines.join("\n");
  }

  interface AgentReply {
    agent?: { content: string; meta?: { pendingActionId?: number; result?: { title?: string; changes?: { name: string; before?: string; after?: string }[] } } };
  }

  function describeAgent(d: AgentReply): string {
    const a = d.agent;
    if (!a) return "Нет ответа агента";
    const lines = [a.content];
    const r = a.meta?.result;
    if (a.meta?.pendingActionId && r?.title) {
      lines.push(`Подтверждаемое действие #${a.meta.pendingActionId}: ${r.title}`);
      for (const c of r.changes ?? []) lines.push(`  • ${c.name}: ${c.before ?? ""} → ${c.after ?? ""}`);
      lines.push("Подтвердите инструментом approve_action или отклоните reject_action.");
    }
    return lines.join("\n");
  }

  const server = new Server({ name: "agent-mr", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "agent_chat",
        description: "Отправить команду агенту на естественном языке (RU/EN). Возвращает ответ; для действий, влияющих на бюджет, — id действия, требующего подтверждения.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "Команда на естественном языке" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        name: "list_pending_actions",
        description: "Список действий, ожидающих подтверждения (dry-run предпросмотры).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "approve_action",
        description: "Подтвердить pending-действие (применить изменения).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number", description: "id действия из list_pending_actions" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "reject_action",
        description: "Отклонить pending-действие (изменения не применяются).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number", description: "id действия" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "spend_report",
        description: "Сводный расход по трём площадкам за период (дни).",
        inputSchema: {
          type: "object",
          properties: { days: { type: "number", minimum: 1, maximum: 90, description: "Период в днях, по умолчанию 7" } },
          additionalProperties: false,
        },
      },
      {
        name: "list_campaigns",
        description: "Кампании и объявления Авито со статистикой за период.",
        inputSchema: {
          type: "object",
          properties: {
            days: { type: "number", minimum: 1, maximum: 90 },
            status: { type: "string", enum: ["all", "active", "paused"] },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
        case "agent_chat": {
          const d = (await api("/api/agent/chat", { method: "POST", body: JSON.stringify({ message: String(args.message ?? "") }) })) as AgentReply;
          return textResult(describeAgent(d));
        }
        case "list_pending_actions": {
          const d = (await api("/api/agent/pending")) as { items?: PendingRow[] };
          const items = d.items ?? [];
          if (!items.length) return textResult("Нет действий, ожидающих подтверждения.");
          return textResult(items.map(describePending).join("\n\n"));
        }
        case "approve_action": {
          const d = (await api("/api/agent/action", { method: "POST", body: JSON.stringify({ id: Number(args.id), decision: "approve" }) })) as AgentReply;
          return textResult(describeAgent(d));
        }
        case "reject_action": {
          const d = (await api("/api/agent/action", { method: "POST", body: JSON.stringify({ id: Number(args.id), decision: "reject" }) })) as AgentReply;
          return textResult(describeAgent(d));
        }
        case "spend_report": {
          const days = Number(args.days ?? 7);
          const d = (await api("/api/agent/chat", { method: "POST", body: JSON.stringify({ message: `Покажи расходы по всем площадкам за последние ${days} дн.` }) })) as AgentReply;
          return textResult(describeAgent(d));
        }
        case "list_campaigns": {
          const days = Number(args.days ?? 7);
          const status = args.status ?? "all";
          const d = (await api(`/api/campaigns?days=${days}&status=${status}`)) as { rows: Record<string, unknown>[] };
          const lines = (d.rows ?? []).map(
            (r) =>
              `${r.name} [${r.platform}/${r.status}] · бюджет ${r.budgetDaily} ₽/д · расход ${r.spend} ₽ · CTR ${r.ctr}%${r.cpa ? ` · CPA ${r.cpa} ₽` : ""}`
          );
          return textResult(lines.length ? `Кампаний: ${lines.length}\n${lines.join("\n")}` : "Не найдено.");
        }
        default:
          throw new Error(`Unknown tool: ${req.params.name}`);
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Ошибка: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}
