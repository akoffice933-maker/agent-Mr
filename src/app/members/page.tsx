"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

const ROLES = ["owner", "admin", "media_buyer", "analyst", "viewer"] as const;

export default function MembersPage() {
  const [data, setData] = useState<{ members: any[]; invites: any[] }>({ members: [], invites: [] });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    const r = await apiFetch("/api/members");
    if (r.ok) setData(await r.json());
    else setError("Нет доступа к управлению командой.");
  };
  // Initial fetch on mount, written as a plain promise chain (matching the
  // pattern in settings-panel.tsx) rather than calling the async `load`
  // function directly — react-hooks/set-state-in-effect flags a direct call
  // to a named async function whose body sets state, even though the actual
  // setState calls happen after an await and are not synchronous.
  useEffect(() => {
    apiFetch("/api/members")
      .then((r) => (r.ok ? r.json().then(setData) : Promise.reject(r)))
      .catch(() => setError("Нет доступа к управлению командой."));
  }, []);

  const invite = async () => {
    setError(""); setToken(null);
    const r = await apiFetch("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
    const d = await r.json();
    // `message` carries the human-readable reason (e.g. the plan-limit text);
    // `error` is the machine code and makes a poor thing to show a user.
    if (!r.ok) return setError(d.message ?? d.error ?? "Ошибка");
    setToken(d.token); setEmail(""); await load();
  };

  const changeRole = async (memberId: number, nextRole: string) => {
    const r = await apiFetch("/api/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId, role: nextRole }) });
    if (!r.ok) setError((await r.json()).error ?? "Ошибка"); else await load();
  };

  const remove = async (memberId: number) => {
    if (!confirm("Удалить участника из организации?")) return;
    const r = await apiFetch("/api/members", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId }) });
    if (!r.ok) setError((await r.json()).error ?? "Ошибка"); else await load();
  };

  return <div className="space-y-6">
    <div><h1 className="font-display text-2xl font-bold text-snow">Команда</h1><p className="mt-1 text-sm text-fog">Участники организации и приглашения.</p></div>
    {error && <div className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm text-bad">{error}</div>}
    {token && <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm"><div className="font-semibold text-snow">Приглашение создано</div><div className="mt-1 break-all font-mono text-xs text-mist">{token}</div><div className="mt-1 text-xs text-fog">Токен показывается один раз. Отправь его пользователю безопасным каналом.</div></div>}
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold text-snow">Пригласить</h2>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-snow outline-none" />
        <select value={role} onChange={e=>setRole(e.target.value)} className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-snow">{ROLES.map(r=><option key={r}>{r}</option>)}</select>
        <button onClick={invite} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink">Создать приглашение</button>
      </div>
    </section>
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold text-snow">Участники</h2>
      <div className="mt-4 divide-y divide-line">{data.members.map(m=><div key={m.id} className="flex items-center gap-3 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-snow">{m.name ?? m.email}</div><div className="text-xs text-fog">{m.email}</div></div><select value={m.role} onChange={e=>changeRole(m.id,e.target.value)} className="rounded border border-line bg-panel2 px-2 py-1 text-xs text-snow">{ROLES.map(r=><option key={r}>{r}</option>)}</select><button onClick={()=>remove(m.id)} className="text-xs text-bad hover:underline">Удалить</button></div>)}</div>
    </section>
  </div>;
}
