// Route-level RBAC guard (Phase D).
//
// Returns a 403 response when the caller's role is DENIED for the action,
// null when the action may proceed. REQUIRE_APPROVAL / LIMITED decisions are
// handled inside the agent flow (approval preview / caps), not at the route.

import { NextResponse } from "next/server";
import { authorize, type Action, type Role } from "@/lib/agent/rbac";
import { roleFromHeaders } from "./request";

export function requireAction(req: Request, action: Action): NextResponse | null {
  const role = roleFromHeaders(new Headers(req.headers));
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
