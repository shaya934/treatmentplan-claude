"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { call, fmtDate } from "@/lib/client";
import { FilesTab } from "@/components/plan/FilesTab";
import { QuestionsTab } from "@/components/plan/QuestionsTab";
import { EditorTab } from "@/components/plan/EditorTab";
import { FinalizeTab } from "@/components/plan/FinalizeTab";
import { useMe } from "@/components/useMe";
import type { PlanBundle } from "@/lib/types";

type Tab = "files" | "questions" | "draft" | "finalize";

export default function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const [b, setB] = useState<PlanBundle | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("draft");

  const reload = useCallback(async () => {
    try {
      setB(await call<PlanBundle>(`/api/plans/${id}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    reload();
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t) setTab(t);
  }, [reload]);

  if (err && !b) return <p className="text-red-600">{err}</p>;
  if (!b) return <p className="text-sm text-slate-500">Loading…</p>;
  const editable = b.permissions.edit && !me.user.support;
  const statusLabel = b.plan.status === "final" ? "Final" : b.review.some((r) => !r.resolved_at) || b.plan.status === "review" ? "Needs review" : "Draft";
  const tabs: Array<[Tab, string]> = [
    ["files", `1. Files & facts (${b.files.length})`],
    ["questions", "2. Guided questions"],
    ["draft", "3. Draft & edit"],
    ["finalize", "4. Check & finalize"],
  ];
  const visible = me.user.role === "read_only" ? tabs.filter(([t]) => t === "draft" || t === "finalize") : tabs;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/clients/${b.client.id}`} className="text-lg font-semibold text-brand-700 hover:underline">
          {b.client.name}
        </Link>
        <span className="text-sm capitalize text-slate-600">
          {b.plan.type} · {fmtDate(b.plan.period_start)} – {fmtDate(b.plan.period_end)} · v{b.version.version} · template v{b.templateVersion}
        </span>
        <span className={`badge ${statusLabel === "Final" ? "bg-emerald-100 text-emerald-800" : statusLabel === "Needs review" ? "bg-amber-100 text-amber-800" : "bg-slate-100"}`}>{statusLabel}</span>
        {me.user.role === "company_admin" && !me.user.support && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600" title="Use the Opus model for narrative, review and edits on this plan">
            <input
              type="checkbox"
              checked={b.plan.complex_case}
              onChange={async (e) => {
                await call(`/api/plans/${id}/complex-case`, { body: { on: e.target.checked } });
                await reload();
              }}
            />
            Complex case model
          </label>
        )}
      </div>
      {b.latestTemplateVersion > b.templateVersion && b.plan.status !== "final" && editable && (
        <div className="flex items-center gap-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          A newer company template (v{b.latestTemplateVersion}) is available. This draft stays on v{b.templateVersion} until you update.
          <button
            className="btn btn-sm ml-auto"
            onClick={async () => {
              if (!confirm("Update this draft to the latest template? Matching fields are kept.")) return;
              const r = await call<{ added: string[]; dropped: string[] }>(`/api/plans/${id}/update-template`, { method: "POST" });
              alert(`Updated. ${r.added.length} new field(s); ${r.dropped.length} field(s) no longer in the template.`);
              await reload();
            }}
          >
            Update to latest template
          </button>
        </div>
      )}
      <div className="flex gap-1 border-b border-slate-200">
        {visible.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-slate-600 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "files" && <FilesTab b={b} reload={reload} editable={editable} />}
      {tab === "questions" && <QuestionsTab b={b} editable={editable} onDone={() => setTab("draft")} />}
      {tab === "draft" && <EditorTab b={b} reload={reload} editable={editable} />}
      {tab === "finalize" && (
        <FinalizeTab
          b={b}
          reload={reload}
          goToField={(fid) => {
            setTab("draft");
            setTimeout(() => document.getElementById(`field-${fid}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
          }}
        />
      )}
    </div>
  );
}
