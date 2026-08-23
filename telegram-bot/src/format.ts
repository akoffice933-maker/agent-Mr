// Formatting of agent replies for Telegram (plain text, ≤4000 chars).

export interface PreviewChange {
  entity?: string;
  name: string;
  before?: string;
  after?: string;
  note?: string;
}

export interface AgentMetaLike {
  tool?: string;
  pendingActionId?: number;
  result?: {
    kind?: string;
    title?: string;
    cost?: number;
    verdict?: string;
    reason?: string;
    changes?: PreviewChange[];
  };
}

export function formatAgentReply(content: string, meta: AgentMetaLike | null | undefined): string {
  const lines: string[] = [content.trim()];
  const r = meta?.result;
  const id = meta?.pendingActionId;

  if (id && r?.kind === "preview" && r.title) {
    lines.push("");
    lines.push(`⏳ Действие #${id}: ${r.title}`);
    for (const c of r.changes ?? []) {
      const arrow = c.before && c.after ? `${c.before} → ${c.after}` : c.after ?? c.before ?? c.note ?? "";
      lines.push(`• ${c.name}${arrow ? `: ${arrow}` : ""}`);
    }
    if (typeof r.cost === "number" && r.cost > 0) {
      lines.push(`≈ +${new Intl.NumberFormat("ru-RU").format(r.cost)} ₽/день к расходу`);
    }
    lines.push("");
    lines.push("Подтвердите кнопками ниже.");
  }
  if (r?.kind === "preview" && r.verdict === "blocked" && r.reason) {
    lines.push(`⛔ ${r.reason}`);
  }

  const out = lines.join("\n");
  return out.length > 3900 ? out.slice(0, 3897) + "…" : out;
}
