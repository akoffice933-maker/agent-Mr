// POST /api/members/accept — complete an organization invitation.
//
// Review M4 (overview): invites were created (POST /api/members) but there was
// no way to CONSUME the returned token, so "team member management" dead-ended.
//
// Flow: the invitee (an authenticated, logged-in user) submits the raw token
// received out-of-band (email/Telegram). We hash it, look up the pending invite,
// verify it is unexpired and unconsumed, then add the CURRENT user to the
// inviting organization with the role the inviter granted. Access to
// org_members/org_invites goes through the identity pool (no RLS) by design —
// membership tables are the tenant-defining identity plane.
//
// Only a SESSION-authenticated human (ctx.userId set) may accept; machine API
// keys carry no user identity and are rejected.

import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { identityPool } from "@/lib/tenant/pool";
import { withTenantRequest } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    // Accepting requires a real user identity (a logged-in human).
    if (!ctx.userId) {
      return NextResponse.json(
        { error: "unauthorized", reason: "Принять приглашение может только авторизованный пользователь." },
        { status: 401 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { token?: string };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return NextResponse.json({ error: "bad_request", reason: "Укажите token приглашения." }, { status: 400 });

    const tokenHash = createHash("sha256").update(token).digest("hex");

    // Look up the invite by its hash ONLY (raw token is never stored/matched).
    const inv = await identityPool.query(
      `SELECT id, org_id, email, role, expires_at, accepted_at, created_at
         FROM org_invites WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const invite = (inv as { rows: { id: number; org_id: number; email: string; role: string; expires_at: Date; accepted_at: Date | null }[] }).rows[0];

    if (!invite) {
      // Do not reveal whether a given token exists.
      return NextResponse.json({ error: "invalid_token", reason: "Приглашение не найдено (неверный или использованный токен)." }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json({ error: "already_accepted", reason: "Приглашение уже использовано." }, { status: 409 });
    }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "expired", reason: "Срок действия приглашения истёк." }, { status: 410 });
    }

    // The invite targets a specific email, chosen at creation time — anyone
    // who merely obtains the token (forwarded to the wrong person, logged,
    // etc.) must not be able to join a different account's org with it.
    const requester = await identityPool.query("SELECT email FROM users WHERE id = $1 LIMIT 1", [ctx.userId]);
    const requesterEmail = (requester as { rows: { email: string }[] }).rows[0]?.email?.toLowerCase();
    if (!requesterEmail || requesterEmail !== invite.email.toLowerCase()) {
      return NextResponse.json(
        { error: "email_mismatch", reason: "Приглашение выписано на другой email. Войдите под тем аккаунтом, куда оно было отправлено." },
        { status: 403 }
      );
    }

    // The invitee must not already be a member of this org.
    const existing = await identityPool.query(
      "SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
      [invite.org_id, ctx.userId]
    );
    if ((existing as { rows: unknown[] }).rows.length > 0) {
      return NextResponse.json({ error: "already_member", reason: "Вы уже состоите в этой организации." }, { status: 409 });
    }

    // The role the inviter granted is the source of truth (validated at invite
    // creation); we reuse it verbatim rather than trusting the request body.
    const memberId = (
      await identityPool.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING RETURNING id`,
        [invite.org_id, ctx.userId, invite.role]
      )
    ) as { rows: { id: number }[] };

    if (memberId.rows.length === 0) {
      // Rare race: a concurrent accept inserted the membership. Treat as OK.
      await identityPool.query(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
      return NextResponse.json({ ok: true, alreadyMember: true });
    }

    await identityPool.query(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
    return NextResponse.json({ ok: true, role: invite.role }, { status: 201 });
  });
}
