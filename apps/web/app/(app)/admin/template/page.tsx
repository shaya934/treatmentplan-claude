"use client";
import { useCallback, useEffect, useState } from "react";
import { call, fmtDateTime } from "@/lib/client";
import { FieldEditor } from "@/components/FieldEditor";
import { VoiceButton } from "@/components/VoiceButton";
import type { Template } from "@/lib/types";

interface Current {
  templateId: string;
  name: string;
  version: number;
  versionId: string;
  template: Template;
  hasWordTemplate: boolean;
  versions: Array<{ id: string; version: number; status: string; published_at: string | null; change_reason: string | null; compliance_override: string | null; published_by_name: string | null }>;
  messages: Array<{ id: string; role: string; content: string; created_at: string }>;
}

interface Proposal {
  template: Template;
  changedSections: string[];
  warnings: Array<{ fieldId?: string; ruleId?: string; message: string }>;
  ops: Array<{ op: string }>;
  summary: string;
}

/** Admin template chatbot (spec F10): plain-language changes -> structured diff + preview -> publish with compliance guard. */
export default function TemplateAdmin() {
  const [cur, setCur] = useState<Current | null>(null);
  const [draft, setDraft] = useState<Proposal | null>(null);
  const [warnings, setWarnings] = useState<Proposal["warnings"]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [log, setLog] = useState<Array<{ role: string; text: string }>>([]);
  const [req, setReq] = useState("");
  const [reason, setReason] = useState("");
  const [compliance, setCompliance] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(async () => setCur(await call<Current>("/api/admin/template")), []);
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, [load]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!req.trim()) return;
    setBusy(true);
    setErr("");
    setLog((l) => [...l, { role: "user", text: req }]);
    try {
      const p = await call<Proposal>("/api/admin/template/chat", { body: { request: req, baseTemplate: draft?.template } });
      setReq("");
      setLog((l) => [...l, { role: "assistant", text: p.summary }]);
      if (p.ops.length) {
        setDraft(p);
        setWarnings((w) => [...w, ...p.warnings]);
        setChanged((c) => Array.from(new Set([...c, ...p.changedSections])));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setErr("");
    try {
      await call("/api/admin/template/publish", { body: { template: draft!.template, changeReason: reason, complianceReason: compliance || undefined, warnings } });
      setDraft(null);
      setWarnings([]);
      setChanged([]);
      setReason("");
      setCompliance("");
      setLog((l) => [...l, { role: "assistant", text: "Published. New plans use the new version; drafts update only when the BCBA chooses to." }]);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function upload(file: File, mode: "export" | "convert") {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("mode", mode);
    setErr("");
    const res = await fetch("/api/admin/template/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) return setErr(data.error);
    if (mode === "convert" && data.draft) {
      setDraft({ template: { ...data.draft, branding: cur!.template.branding }, changedSections: data.draft.sections.map((s: { id: string }) => s.id), warnings: [], ops: [{ op: "import" }], summary: "Converted from DOCX" });
      setChanged(data.draft.sections.map((s: { id: string }) => s.id));
      setLog((l) => [...l, { role: "assistant", text: `Converted ${file.name} into a structured draft with ${data.draft.sections.length} sections. Review it below before publishing.` }]);
    } else await load();
  }

  if (!cur) return <p className="text-sm text-slate-500">{err || "Loading…"}</p>;
  const shown = draft?.template ?? cur.template;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{cur.name}</h1>
          <span className="badge bg-slate-100">published v{cur.version}</span>
          {draft && <span className="badge bg-amber-100 text-amber-800">unpublished draft ({changed.length} section(s) changed)</span>}
          <button className="btn btn-sm ml-auto" onClick={() => setShowJson(!showJson)}>
            {showJson ? "Show preview" : "Show JSON"}
          </button>
        </div>
        {showJson ? (
          <pre className="card max-h-[75vh] overflow-auto p-3 text-[11px]">{JSON.stringify(shown, null, 2)}</pre>
        ) : (
          <div className="card divide-y divide-slate-100">
            {shown.sections.map((s) => (
              <section key={s.id} className={`p-4 ${changed.includes(s.id) ? "bg-amber-50/60" : ""}`}>
                <h2 className="mb-2 flex items-center gap-2 rounded bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white">
                  {s.title} {changed.includes(s.id) && <span className="badge bg-amber-300 text-amber-900">changed</span>}
                </h2>
                {changed.includes(s.id) ? (
                  <div className="space-y-1">
                    <p className="text-xs text-slate-500">Sample rendered page:</p>
                    {s.fields.map((f) => (
                      <FieldEditor key={f.id} field={f} entry={undefined} readOnly vars={{ first_name: "Client", full_name: "Client Name", age: "7", gender: "", diagnosis: "F84.0" }} onSave={() => {}} onSelect={() => {}} selected={false} />
                    ))}
                  </div>
                ) : (
                  <ul className="grid gap-x-4 text-xs text-slate-600 md:grid-cols-2">
                    {s.fields
                      .filter((f) => f.type !== "static")
                      .map((f) => (
                        <li key={f.id} className="truncate">
                          {f.label.split("(")[0]} <span className="text-slate-400">· {f.type}/{f.lengthType}</span>
                          {f.required && <span className="text-red-500"> *</span>}
                          {f.tags.includes("ccp8f_required") && <span className="ml-1 badge bg-sky-100 text-sky-800">CCP 8F</span>}
                        </li>
                      ))}
                  </ul>
                )}
              </section>
            ))}
            <section className="p-4">
              <h2 className="mb-2 text-sm font-semibold">Validation rules</h2>
              <ul className="space-y-0.5 text-xs text-slate-600">
                {shown.rules.map((r) => (
                  <li key={r.id}>
                    <span className="font-mono">{r.id}</span> — {r.message ?? r.kind}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="card flex flex-col p-4">
          <h2 className="mb-2 font-semibold">Template assistant</h2>
          <div className="max-h-72 flex-1 space-y-2 overflow-y-auto">
            {log.length === 0 && <p className="text-sm text-slate-500">Describe a change, e.g. “Add a feeding concerns field under Developmental History” or “Require 3 caregiver goals”. Nothing changes until you publish.</p>}
            {log.map((m, i) => (
              <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-8 bg-brand-600 text-white" : "mr-8 bg-slate-100"}`}>
                {m.text}
              </div>
            ))}
          </div>
          <form onSubmit={send} className="mt-3 space-y-2">
            <textarea className="input min-h-[64px]" value={req} onChange={(e) => setReq(e.target.value)} placeholder="Describe the template change…" />
            <div className="flex gap-2">
              <VoiceButton onText={(t) => setReq((x) => (x ? `${x} ${t}` : t))} disabled={busy} />
              <button className="btn-primary ml-auto" disabled={busy || !req.trim()}>
                {busy ? "Working…" : "Propose change"}
              </button>
            </div>
          </form>
        </div>

        {draft && (
          <div className="card space-y-3 p-4">
            <h2 className="font-semibold">Publish</h2>
            {warnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
                <b>Compliance guard</b>
                {warnings.map((w, i) => (
                  <p key={i}>{w.message}</p>
                ))}
                <label className="label mt-2 text-red-700">Reason for loosening a CCP 8F requirement (required)</label>
                <textarea className="input" value={compliance} onChange={(e) => setCompliance(e.target.value)} />
              </div>
            )}
            <div>
              <label className="label">Change description</label>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Added feeding concerns per Trillium feedback" />
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex gap-2">
              <button className="btn-primary" disabled={!reason.trim() || (warnings.length > 0 && !compliance.trim())} onClick={publish}>
                Publish new version
              </button>
              <button
                className="btn"
                onClick={() => {
                  setDraft(null);
                  setWarnings([]);
                  setChanged([]);
                }}
              >
                Discard draft
              </button>
            </div>
          </div>
        )}

        <div className="card space-y-2 p-4 text-sm">
          <h2 className="font-semibold">Word template</h2>
          <p className="text-xs text-slate-500">{cur.hasWordTemplate ? "A company Word template is used for DOCX/PDF export." : "Exports use the built-in layout. Upload your company .docx (with a {@body} paragraph and optional {company}, {client_name}, {final_date} tags) to use your own header, footer and logo."}</p>
          <label className="btn btn-sm cursor-pointer">
            Upload export template (.docx)
            <input type="file" accept=".docx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], "export")} />
          </label>
          <label className="btn btn-sm cursor-pointer">
            Convert a .docx into a template draft
            <input type="file" accept=".docx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], "convert")} />
          </label>
        </div>

        <div className="card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Version history</h2>
          <ul className="space-y-1.5">
            {cur.versions
              .filter((v) => v.status === "published")
              .map((v) => (
                <li key={v.id} className="flex items-start gap-2">
                  <span className="font-mono text-xs">v{v.version}</span>
                  <div className="flex-1 text-xs">
                    <div>{v.change_reason}</div>
                    <div className="text-slate-500">
                      {v.published_by_name ?? "System"} · {v.published_at ? fmtDateTime(v.published_at) : ""}
                    </div>
                    {v.compliance_override && <div className="text-red-700">Compliance override: {v.compliance_override}</div>}
                  </div>
                  {v.id === cur.versionId ? (
                    <span className="badge bg-emerald-100 text-emerald-800">current</span>
                  ) : (
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        const r = prompt(`Roll back to v${v.version}? New plans will use it. Reason:`);
                        if (!r) return;
                        await call("/api/admin/template/rollback", { body: { versionId: v.id, reason: r } });
                        await load();
                      }}
                    >
                      Roll back
                    </button>
                  )}
                </li>
              ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
