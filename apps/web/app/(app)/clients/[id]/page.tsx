"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { call, fmtDate } from "@/lib/client";
import { useMe } from "@/components/useMe";

interface Data {
  client: { id: string; name: string; dob: string | null; gender: string | null; medicaid_id: string | null; payer: string | null; diagnosis: string | null; assigned_bcba_id: string | null; bcba_name: string | null; auth_end_date: string | null };
  plans: Array<{ id: string; type: string; status: string; period_start: string | null; period_end: string | null; final_date: string | null; current_version: number; created_at: string }>;
}

function addDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const router = useRouter();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [plan, setPlan] = useState({ type: "reassessment", periodStart: today, periodEnd: addDays(today, 179) });
  const [bcbas, setBcbas] = useState<Array<{ id: string; name: string }>>([]);
  const [edit, setEdit] = useState<{ name: string; dob: string; gender: string; medicaidId: string; payer: string; diagnosis: string } | null>(null);
  useEffect(() => {
    call<Data>(`/api/clients/${id}`).then((x) => {
      setD(x);
      if (!x.plans.some((p) => p.status === "final")) setPlan((p) => ({ ...p, type: "initial" }));
    }).catch((e) => setErr(e.message));
    if (me.can["client.reassign"]) call<typeof bcbas>("/api/bcbas").then(setBcbas);
  }, [id, me]);
  async function start(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await call<{ id: string }>("/api/plans", { body: { clientId: id, ...plan } });
      router.push(`/plans/${r.id}?tab=files`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setErr("");
    try {
      await call(`/api/clients/${id}`, { method: "PATCH", body: { ...edit, dob: edit.dob || null } });
      setD(await call<Data>(`/api/clients/${id}`));
      setEdit(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  if (err && !d) return <p className="text-red-600">{err}</p>;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  const c = d.client;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="card space-y-2 p-5 lg:col-span-1">
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-lg font-semibold">{c.name}</h1>
          {me.can["client.create"] && !edit && (
            <button
              className="btn btn-sm"
              onClick={() => setEdit({ name: c.name, dob: c.dob?.slice(0, 10) ?? "", gender: c.gender ?? "", medicaidId: c.medicaid_id ?? "", payer: c.payer ?? "", diagnosis: c.diagnosis ?? "" })}
            >
              Edit
            </button>
          )}
        </div>
        {edit && (
          <form onSubmit={saveEdit} className="space-y-2 text-sm">
            <div>
              <label className="label">Name (Last, First)</label>
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Date of birth</label>
              <input className="input" type="date" value={edit.dob} onChange={(e) => setEdit({ ...edit, dob: e.target.value })} />
            </div>
            <div>
              <label className="label">Gender</label>
              <input className="input" value={edit.gender} onChange={(e) => setEdit({ ...edit, gender: e.target.value })} />
            </div>
            <div>
              <label className="label">Medicaid ID</label>
              <input className="input" value={edit.medicaidId} onChange={(e) => setEdit({ ...edit, medicaidId: e.target.value })} />
            </div>
            <div>
              <label className="label">Payer</label>
              <input className="input" value={edit.payer} onChange={(e) => setEdit({ ...edit, payer: e.target.value })} placeholder="e.g. Trillium" />
            </div>
            <div>
              <label className="label">Diagnosis</label>
              <input className="input" value={edit.diagnosis} onChange={(e) => setEdit({ ...edit, diagnosis: e.target.value })} />
            </div>
            {err && <p className="text-red-600">{err}</p>}
            <div className="flex gap-2">
              <button className="btn-primary">Save</button>
              <button type="button" className="btn" onClick={() => (setEdit(null), setErr(""))}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <dl className={`grid grid-cols-2 gap-y-1 text-sm ${edit ? "hidden" : ""}`}>
          <dt className="text-slate-500">DOB</dt>
          <dd>{fmtDate(c.dob)}</dd>
          <dt className="text-slate-500">Gender</dt>
          <dd>{c.gender}</dd>
          <dt className="text-slate-500">Medicaid ID</dt>
          <dd>{c.medicaid_id}</dd>
          <dt className="text-slate-500">Payer</dt>
          <dd>{c.payer}</dd>
          <dt className="text-slate-500">Diagnosis</dt>
          <dd>{c.diagnosis}</dd>
          <dt className="text-slate-500">BCBA</dt>
          <dd>{c.bcba_name ?? "Unassigned"}</dd>
          <dt className="text-slate-500">Auth. ends</dt>
          <dd>{fmtDate(c.auth_end_date)}</dd>
        </dl>
        {me.can["client.reassign"] && (
          <div className="pt-2">
            <label className="label">Reassign to</label>
            <select
              className="input"
              value={c.assigned_bcba_id ?? ""}
              onChange={async (e) => {
                await call(`/api/clients/${id}/reassign`, { body: { bcbaId: e.target.value } });
                setD(await call<Data>(`/api/clients/${id}`));
              }}
            >
              <option value="" disabled>
                Choose…
              </option>
              {bcbas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {me.user.role === "company_admin" && !me.user.support && (
          <button
            className="btn btn-sm mt-3 text-red-700"
            onClick={async () => {
              const confirm = prompt("This permanently deletes this client's plans, files and answers (HIPAA deletion request). Type DELETE to confirm.");
              if (confirm !== "DELETE") return;
              await call(`/api/clients/${id}/delete-data`, { body: { confirm } });
              router.push("/clients");
            }}
          >
            Delete client data on request
          </button>
        )}
      </div>
      <div className="space-y-4 lg:col-span-2">
        {!me.can["plan.create"] && me.user.role === "company_admin" && !me.user.support && (
          <p className="card p-4 text-sm text-slate-600">
            Plans are started by a BCBA. To start plans yourself, set your credential to <strong>BCBA</strong> on the{" "}
            <Link href="/admin/users" className="text-brand-600 hover:underline">
              Users
            </Link>{" "}
            page, then reload this page. Or add a BCBA user and assign this client to them.
          </p>
        )}
        {me.can["plan.create"] && (
          <form onSubmit={start} className="card flex flex-wrap items-end gap-3 p-4">
            <div>
              <label className="label">Plan type</label>
              <select className="input" value={plan.type} onChange={(e) => setPlan({ ...plan, type: e.target.value })}>
                <option value="initial">Initial assessment</option>
                <option value="reassessment">Reassessment</option>
              </select>
            </div>
            <div>
              <label className="label">Review period start</label>
              <input className="input" type="date" value={plan.periodStart} onChange={(e) => setPlan({ ...plan, periodStart: e.target.value })} />
            </div>
            <div>
              <label className="label">End</label>
              <input className="input" type="date" value={plan.periodEnd} onChange={(e) => setPlan({ ...plan, periodEnd: e.target.value })} />
            </div>
            <button className="btn-primary">Start plan</button>
            <p className="w-full text-xs text-slate-500">Uses the latest company template. A reassessment carries forward content from the last finalized plan, marked “carried forward – confirm”.</p>
            {err && <p className="w-full text-sm text-red-600">{err}</p>}
          </form>
        )}
        <div className="card overflow-hidden">
          <table className="tbl">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Period</th>
                <th>Status</th>
                <th>Final date</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {d.plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/plans/${p.id}`} className="capitalize text-brand-600 hover:underline">
                      {p.type}
                    </Link>
                  </td>
                  <td>
                    {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                  </td>
                  <td className="capitalize">{p.status}</td>
                  <td>{fmtDate(p.final_date)}</td>
                  <td>v{p.current_version}</td>
                </tr>
              ))}
              {d.plans.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">
                    No plans yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
