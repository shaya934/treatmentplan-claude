"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { call, fmtDate } from "@/lib/client";
import { useMe } from "@/components/useMe";

interface Dash {
  plans: Array<{ id: string; client_id: string; client_name: string; type: string; status: string; display_status: string; period_start: string | null; period_end: string | null; updated_at: string; bcba_name: string | null; open_review: string }>;
  alerts: Array<{ client_id: string; client_name: string; auth_end_date: string; days_left: number; level: number }>;
}

const STATUS_STYLE: Record<string, string> = { Draft: "bg-slate-100 text-slate-700", "Needs review": "bg-amber-100 text-amber-800", Final: "bg-emerald-100 text-emerald-800" };
const ALERT_STYLE: Record<number, string> = { 14: "border-red-300 bg-red-50 text-red-800", 30: "border-amber-300 bg-amber-50 text-amber-800", 60: "border-sky-300 bg-sky-50 text-sky-800" };

export default function Dashboard() {
  const me = useMe();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (me.user.role === "super_admin" && !me.user.tenantId) {
      window.location.href = "/super";
      return;
    }
    call<Dash>("/api/dashboard").then(setD).catch((e) => setErr(e.message));
  }, [me]);
  if (err) return <p className="text-red-600">{err}</p>;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  const admin = me.user.role === "company_admin" || me.user.role === "clinical_director";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{admin ? "All plans" : "My plans"}</h1>
        {me.can["client.create"] && (
          <Link href="/clients/new" className="btn-primary">
            New client
          </Link>
        )}
      </div>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Authorization end dates</h2>
        {d.alerts.length === 0 ? (
          <p className="text-sm text-slate-500">No authorizations ending in the next 60 days.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.alerts.map((a) => (
              <Link key={a.client_id} href={`/clients/${a.client_id}`} className={`rounded-md border px-3 py-2 text-sm ${ALERT_STYLE[a.level]}`}>
                <div className="font-medium">{a.client_name}</div>
                <div>
                  Authorization ends {fmtDate(a.auth_end_date)} · {a.days_left < 0 ? `${-a.days_left} days ago` : `${a.days_left} days left`} ({a.level}-day alert)
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Client</th>
              <th>Plan</th>
              <th>Period</th>
              {admin && <th>BCBA</th>}
              <th>Status</th>
              <th>Review items</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {d.plans.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td>
                  <Link className="text-brand-600 hover:underline" href={`/plans/${p.id}`}>
                    {p.client_name}
                  </Link>
                </td>
                <td className="capitalize">{p.type}</td>
                <td>
                  {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                </td>
                {admin && <td>{p.bcba_name}</td>}
                <td>
                  <span className={`badge ${STATUS_STYLE[p.display_status]}`}>{p.display_status}</span>
                </td>
                <td>{Number(p.open_review) || ""}</td>
                <td className="text-slate-500">{new Date(p.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {d.plans.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  No plans yet. Open a client to start one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
