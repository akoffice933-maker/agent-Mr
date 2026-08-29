// Route-level RBAC guard (Phase D).
//
// Returns a 403 response when the caller's role is DENIED for the action,
// null when the action may proceed. REQUIRE_APPROVAL / LIMITED decisions are
// handled inside the agent flow (approval preview / caps), not at the route.

import { NextResponse } from "next/server";
import { authorize, type Action, type Role } from "@/lib/agent/rbac";
import { roleFromHeaders, scopesFromHeaders } from "./request";
import { hasScope, scopeForAction } from "@/lib/agent/scopes";

export function requireAction(req: Request, action: Action): NextResponse | null {
  const headers = new Headers(req.headers);
  const role = roleFromHeaders(headers);
  const scopes = scopesFromHeaders(headers);
  if (scopes !== null && !hasScope(scopes, scopeForAction(action))) {
    return NextResponse.json({ error: "forbidden", reason: `API key не имеет scope: ${scopeForAction(action)}` }, { status: 403 });
  }
  const r = authorize({ role, action });
  if (r.decision === "DENY") {
    return NextResponse.json({ error: "forbidden", reason: r.reason }, { status: 403 });
  }
  return null;
}

/** Variant for routes that resolve the tenant context themselves (e.g. OAuth). */
export function requireActionRole(role: Role, action: Action): NextResponse | null {
  const r = authorize({ role, action });
  if (r.decision === "DENY") {
    return NextResponse.json({ error: "forbidden", reason: r.reason }, { status: 403 });
  }
  return null;
}
