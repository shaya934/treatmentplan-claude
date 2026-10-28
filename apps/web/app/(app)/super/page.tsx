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
                  </button>{" "}
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      if (!confirm(`Give ${t.name} the standard template as a new version? Plans already started keep their version; new plans use the standard. The company can roll back from its version history.`)) return;
                      try {
                        const r = await call<{ version: number }>("/api/super/template/apply", { body: { tenantId: t.id } });
                        alert(`${t.name} now uses the standard template (version ${r.version}).`);
                      } catch (e) {
                        alert((e as Error).message);
                      }
                    }}
                  >
                    Apply standard template
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
        <p className="text-xs text-slate-500 md:col-span-4">Each company gets its own data, users and a copy of the standard template below. Sign a BAA with the company before they upload real PHI.</p>
        {err && <p className="text-sm text-red-600 md:col-span-5">{err}</p>}
      </form>
      <StandardTemplate />
    </div>
  );
}

interface TemplateShape {
  name: string;
  sections: Array<{ id: string; title: string; fields: Array<{ id: string; label: string; type: string; required?: boolean; question?: string }> }>;
}
interface StandardInfo {
  template: TemplateShape;
  version: number | null;
  builtIn: boolean;
  publishedAt: string | null;
  changeReason: string | null;
}

/** The platform standard template: new companies start with a copy; existing companies are not changed. */
function StandardTemplate() {
  const [cur, setCur] = useState<StandardInfo | null>(null);
  const [draft, setDraft] = useState<TemplateShape | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = () => call<StandardInfo>("/api/super/template").then(setCur).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function upload(file: File) {
    setErr("");
    setDraft(null);
    setBusy("Converting your Word template… this usually takes about a minute.");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/super/template/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Conversion failed");
      setDraft(data.draft);
      setReason(`Standard template from ${file.name}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function publish(builtIn = false) {
    setErr("");
    setBusy("Publishing…");
    try {
      await call("/api/super/template", { body: builtIn ? { builtIn: true, changeReason: "Restored the built-in standard template" } : { template: draft, changeReason: reason } });
      setDraft(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const count = (t: TemplateShape) => t.sections.reduce((n, s) => n + s.fields.filter((f) => f.type !== "static").length, 0);
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h2 className="font-semibold">Standard template for new companies</h2>
          <p className="text-sm text-slate-500">
            Every company you onboard starts with a copy of this template; each company can then change its own copy. Existing companies are not affected.
          </p>
          {cur && (
            <p className="mt-1 text-sm">
              Current: <strong>{cur.builtIn ? "built-in template" : `version ${cur.version}`}</strong> · {cur.template.sections.length} sections, {count(cur.template)} fields
              {cur.publishedAt && <span className="text-slate-500"> · published {new Date(cur.publishedAt).toLocaleString()} – {cur.changeReason}</span>}
            </p>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <label className={`btn-primary cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
            Upload Word template (.docx)
            <input type="file" accept=".docx" className="hidden" onChange={(e) => (e.target.files?.[0] && upload(e.target.files[0]), (e.target.value = ""))} />
          </label>
          {cur && !cur.builtIn && (
            <button className="btn" disabled={!!busy} onClick={() => confirm("Make the built-in template the standard again?") && publish(true)}>
              Restore built-in
            </button>
          )}
        </div>
      </div>
      {busy && <p className="text-sm text-slate-600">{busy}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {draft && (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm">
            <strong>Draft – not saved yet.</strong> Found {draft.sections.length} sections and {count(draft)} fields. Check them below, then publish.
          </p>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded bg-white p-3">
            {draft.sections.map((s) => (
              <details key={s.id} className="text-sm">
                <summary className="cursor-pointer font-medium">
                  {s.title} <span className="text-slate-500">({s.fields.filter((f) => f.type !== "static").length} fields)</span>
                </summary>
                <ul className="ml-5 mt-1 list-disc text-xs text-slate-700">
                  {s.fields.map((f) => (
                    <li key={f.id}>
                      {f.label} <span className="text-slate-400">· {f.type}{f.required ? " · required" : ""}</span>
                      {f.question && <div className="text-slate-500">Question: {f.question}</div>}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <label className="label">Change description</label>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button className="btn-primary" disabled={!!busy || !reason.trim()} onClick={() => publish()}>
              Publish as standard
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
