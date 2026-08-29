import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { identityPool } from "@/lib/tenant/pool";
import { requireAction } from "@/lib/tenant/route-authz";
import { withTenantRequest } from "@/lib/tenant/request";
import { ROLES, type Role } from "@/lib/agent/rbac";

export const dynamic = "force-dynamic";

function validRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

async function ownerCount(orgId: number) {
  const r = await identityPool.query("SELECT count(*)::int AS n FROM org_members WHERE org_id=$1 AND role='owner'", [orgId]);
  return Number((r as { rows: { n: number }[] }).rows[0]?.n ?? 0);
}

export async function GET(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    const r = await identityPool.query(
      `SELECT m.id, m.user_id, u.email, u.name, m.role, m.created_at
         FROM org_members m JOIN users u ON u.id=m.user_id
        WHERE m.org_id=$1 ORDER BY m.created_at`,
      [ctx.orgId]
    );
    const invites = await identityPool.query(
      `SELECT id, email, role, created_at, expires_at, accepted_at
         FROM org_invites WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [ctx.orgId]
    );
    return NextResponse.json({ members: (r as { rows: unknown[] }).rows, invites: (invites as { rows: unknown[] }).rows });
  });
}

export async function POST(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    const denied = requireAction(req, "manage_members");
    if (denied) return denied;
    const body = (await req.json()) as { email?: string; role?: string };
    const email = body.email?.toLowerCase().trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !validRole(body.role)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const token = `inv_${randomBytes(32).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await identityPool.query(
      `INSERT INTO org_invites (org_id,email,role,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '7 days')`,
      [ctx.orgId, email, body.role, tokenHash]
    );
    // Delivery is intentionally outside this phase. The raw token is returned once
    // so an email/Telegram provider can be attached without storing credentials here.
    return NextResponse.json({ ok: true, email, role: body.role, token, expiresIn: "7d" }, { status: 201 });
  });
}

export async function PATCH(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    const denied = requireAction(req, "manage_members");
    if (denied) return denied;
    const body = (await req.json()) as { memberId?: number; role?: string };
    if (!body.memberId || !validRole(body.role)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const current = await identityPool.query("SELECT role FROM org_members WHERE id=$1 AND org_id=$2", [body.memberId, ctx.orgId]);
    const old = (current as { rows: { role: string }[] }).rows[0];
    if (!old) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (old.role === "owner" && body.role !== "owner" && (await ownerCount(ctx.orgId)) <= 1) {
      return NextResponse.json({ error: "last_owner" }, { status: 409 });
    }
    await identityPool.query("UPDATE org_members SET role=$1 WHERE id=$2 AND org_id=$3", [body.role, body.memberId, ctx.orgId]);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    const denied = requireAction(req, "manage_members");
    if (denied) return denied;
    const body = (await req.json()) as { memberId?: number };
    if (!body.memberId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const current = await identityPool.query("SELECT role,user_id FROM org_members WHERE id=$1 AND org_id=$2", [body.memberId, ctx.orgId]);
    const member = (current as { rows: { role: string; user_id: number }[] }).rows[0];
    if (!member) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (member.role === "owner" && (await ownerCount(ctx.orgId)) <= 1) return NextResponse.json({ error: "last_owner" }, { status: 409 });
    await identityPool.query("DELETE FROM org_members WHERE id=$1 AND org_id=$2", [body.memberId, ctx.orgId]);
    return NextResponse.json({ ok: true });
  });
}
