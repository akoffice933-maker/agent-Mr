// Deterministic correlation naming for agent-created Yandex Direct resources
// (review P0: idempotent campaign creation — provider resource discovery).
//
// Yandex Direct has no client-token idempotency (unlike Google Ads
// requestId), so re-running a create after a timeout would duplicate the
// campaign. The correlation tag baked into the campaign name is the
// provider-side fingerprint: before creating, the builder searches for an
// existing campaign with the same tag and ADOPTS it instead of duplicating.
//
// Format: `agentmr:{orgId}:{actionId}` (actionId = pending_actions.id —
// stable per confirmed action, unique per organization).

export const CORRELATION_PREFIX = "agentmr";

/** Full provider-facing name: human part + correlation tag. */
export function correlationName(orgId: number, actionId: number, humanName?: string): string {
  const tag = `${CORRELATION_PREFIX}:${orgId}:${actionId}`;
  const base = (humanName ?? "").trim();
  const name = base ? `${base} · ${tag}` : tag;
  // Direct campaign name limit is 255 chars — truncate the human part, never the tag.
  if (name.length <= 255) return name;
  const overflow = name.length - 255;
  return `${base.slice(0, Math.max(0, base.length - overflow - 3)).trimEnd()}… · ${tag}`;
}

/** Extract (orgId, actionId) from a provider name, if it carries our tag. */
export function parseCorrelation(name: string): { orgId: number; actionId: number } | null {
  const m = name.match(/agentmr:(\d+):(\d+)(?:$|\s)/);
  if (!m) return null;
  const orgId = Number(m[1]);
  const actionId = Number(m[2]);
  if (!Number.isInteger(orgId) || !Number.isInteger(actionId)) return null;
  return { orgId, actionId };
}
