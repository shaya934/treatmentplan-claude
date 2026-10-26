"use client";
import { useEffect, useState } from "react";
import { call } from "@/lib/client";
import { useMe } from "@/components/useMe";

interface T {
  id: string;
  name: string;
  slug: string;
  status: string;
  users: string;
  ai_cost_month: string;
  narrative_calls_month: string;
}

/** Platform owner console: tenants, onboarding, usage, logged support access. No client data here. */
export default function Super() {
  const me = useMe();
  const [ts, setTs] = useState<T[]>([]);
  const [f, setF] = useState({ name: "", slug: "", adminEmail: "", adminName: "", tempPassword: "" });
  const [err, setErr] = useState("");
  const load = () => call<T[]>("/api/super/tenants").then(setTs);
  useEffect(() => {
    load();
  }, []);
  if (me.user.role !== "super_admin") return <p>Not allowed.</p>;
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Platform</h1>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Company</th>
              <th>Slug</th>
              <th>Users</th>
              <th>Narratives this month</th>
              <th>AI cost this month</th>
              <th>Support access</th>
            </tr>
          </thead>
          <tbody>
            {ts.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="font-mono text-xs">{t.slug}</td>
                <td>{t.users}</td>
                <td>{t.narrative_calls_month}</td>
                <td>${Number(t.ai_cost_month).toFixed(2)}</td>
                <td>
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      const reason = prompt("Reason for accessing this company's data (logged in their audit log):");
                      if (!reason) return;
                      try {
                        const g = await call<{ id: string }>("/api/super/grants", { body: { tenantId: t.id, reason, minutes: 30 } });
                        await call("/api/super/enter", { body: { grantId: g.id } });
                        window.location.href = "/";
                      } catch (e) {
                        alert((e as Error).message);
                      }
                    }}
                  >
                    Open 30-min support session
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card grid gap-3 p-4 md:grid-cols-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          try {
            await call("/api/super/tenants", { body: f });
            setF({ name: "", slug: "", adminEmail: "", adminName: "", tempPassword: "" });
            await load();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <h2 className="font-semibold md:col-span-5">Onboard a company</h2>
        <input className="input" placeholder="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} required />
        <input className="input" placeholder="slug" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} required />
        <input className="input" placeholder="Admin email" type="email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} required />
        <input className="input" placeholder="Admin name" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} required />
        <input className="input" placeholder={me.mode === "aws" ? "(Cognito emails a password)" : "Temp password (12+)"} value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} required={me.mode !== "aws"} />
        <button className="btn-primary w-fit">Create company</button>
        <p className="text-xs text-slate-500 md:col-span-4">Each company gets its own data, users and a copy of the starter template. Sign a BAA with the company before they upload real PHI.</p>
        {err && <p className="text-sm text-red-600 md:col-span-5">{err}</p>}
      </form>
    </div>
  );
}
