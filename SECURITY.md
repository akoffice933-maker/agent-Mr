# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[Report a vulnerability](https://github.com/akoffice933-maker/agent-Mr/security/advisories/new)
form (Security → Advisories), which keeps the discussion private until a fix
ships.

Useful things to include: what an attacker can achieve, the steps to reproduce,
the affected version/commit, and the impact you believe it has.

Expect an acknowledgement within a few days. Please give us a reasonable window
to ship a fix before disclosing publicly.

## What this project protects

The agent holds OAuth tokens for live advertising accounts and can spend real
money, so these are the areas where a bug matters most:

| Area | Why it is sensitive |
|---|---|
| **Tenant isolation** | One organization reading or writing another's data. Enforced by Postgres RLS (`FORCE ROW LEVEL SECURITY` on 13 tables) plus a tenant context bound per request. |
| **Execution pipeline** | Anything that lets a write reach a provider without policy checks, approval, or read-back verification — or that records a false outcome in the audit log. |
| **Credentials** | OAuth tokens (AES-256-GCM at rest), API keys (sha256, raw value never stored), session cookies. |
| **Safety interlocks** | `read_only` / `dry_run` defaults and spend limits. Anything that turns these off implicitly is a security issue, not a bug. |
| **Authentication** | Session validation, the `x-tenant-*` internal header boundary, brute-force lockout, machine-key scopes. |
| **SSRF** | Any user-controlled URL fetched server-side (`src/lib/fetch-safe.ts`). |

## Security model in brief

- **Fail-closed by default.** An unknown role parses to `viewer`; a new
  organization starts read-only with dry-run enabled; a missing tenant context
  yields zero rows rather than all rows.
- **`x-tenant-*` headers are internal.** The proxy strips any client-supplied
  copy before setting its own. They are never accepted from a request body or
  query parameter.
- **Server-rendered pages authorize through the DAL** (`src/lib/auth/dal.ts`),
  not through headers alone.
- **Writes go through the execution pipeline**: policy → pending action →
  provider write → read-back → `verified` / `failed`. The audit log records the
  real outcome.
- **Machine keys are least-privilege**: the role is derived from the key's
  scopes, so a read-only key cannot satisfy a write-level role check.

`npm run audit:rls` is a live regression guard for the isolation invariants and
runs in CI on every push.

## Deployment requirements

Getting these wrong reintroduces vulnerabilities the code cannot defend against:

- `ENCRYPTION_KEY` — a strong, unique value. Rotating it invalidates stored
  OAuth tokens.
- `TRUSTED_PROXY` — required when running behind a reverse proxy, otherwise
  `X-Forwarded-For` can be spoofed to evade rate limits and the login lockout.
  The proxy must **append** its address as the last hop.
- `TELEGRAM_ALLOWED_CHATS` — the bot holds an API key; without an allowlist it
  is refused to everyone by design.
- Do not publish the database port. `docker-compose.yml` binds it to
  `127.0.0.1`.
- Run behind TLS. Session cookies are `HttpOnly` + `SameSite=Strict` and rely on
  HTTPS in production.

## Supported versions

This is pre-1.0 software under active development: fixes land on `main`, and
there are no maintained release branches.
