"use client";
import { useCallback, useEffect, useState } from "react";
import { call, fmtDate, pollJob } from "@/lib/client";
import type { PlanBundle } from "@/lib/types";

interface Violation {
  ruleId: string;
  fieldId?: string;
  message: string;
  severity: "error" | "warning";
}

/** CCP 8F checks, finalize (lock + date stamp) and export (spec F8, F9). */
export function FinalizeTab({ b, reload, goToField }: { b: PlanBundle; reload: () => Promise<void>; goToField: (id: string) => void }) {
  const [v, setV] = useState<Violation[] | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);

  const run = useCallback(async () => {
    setV((await call<{ violations: Violation[] }>(`/api/plans/${b.plan.id}/validate`)).violations);
  }, [b.plan.id]);
  useEffect(() => {
    run();
  }, [run, b.version.version]);

  async function exportAs(format: "docx" | "pdf") {
    setErr("");
    setBusy(format);
    try {
      const { jobId } = await call<{ jobId: string }>(`/api/plans/${b.plan.id}/export`, { body: { format } });
      const j = await pollJob(jobId);
      if (j.status === "failed" || !j.downloadUrl) throw new Error(j.error ?? "Export failed");
      window.location.href = j.downloadUrl;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const fieldLabel = (id?: string) => b.template.sections.flatMap((s) => s.fields).find((f) => f.id === id)?.label.split("(")[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="card p-5">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-semibold">CCP 8F checks</h2>
          <button className="btn btn-sm" onClick={run}>
            Re-run
          </button>
          {v && <span className={`badge ${v.length ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>{v.length ? `${v.length} to fix` : "All checks pass"}</span>}
        </div>
        {!v ? (
          <p className="text-sm text-slate-500">Checking…</p>
        ) : v.length === 0 ? (
          <p className="text-sm text-emerald-700">Every required section is present, linked hours match, goals and caregiver rules are met, telehealth and authorization limits are respected, and no placeholders remain.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {[...v].sort((a, b) => Number(a.ruleId === "no_placeholders") - Number(b.ruleId === "no_placeholders")).filter((x) => x.ruleId !== "no_placeholders" || showAll || v.filter((y) => y.ruleId === "no_placeholders").indexOf(x) < 5).map((x, i) => (
              <li key={i} className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5">
                <span className="text-red-700">●</span>
                <span className="flex-1">
                  {x.message}
                  {x.fieldId && fieldLabel(x.fieldId) && <span className="text-slate-500"> — {fieldLabel(x.fieldId)}</span>}
                </span>
                {x.fieldId && (
                  <button className="btn btn-sm" onClick={() => goToField(x.fieldId!)}>
                    Fix
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {v && v.filter((y) => y.ruleId === "no_placeholders").length > 5 && (
          <button className="btn btn-sm mt-2" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer placeholders" : `Show all ${v.filter((y) => y.ruleId === "no_placeholders").length} placeholders`}
          </button>
        )}
        <p className="mt-4 text-xs text-slate-500">Rules come from the company template, so admins can update them when policy changes.</p>
      </div>
      <div className="space-y-4">
        <div className="card space-y-3 p-5">
          <h2 className="font-semibold">Finalize</h2>
          {b.plan.status === "final" ? (
            <>
              <p className="text-sm">
                Finalized {fmtDate(b.plan.final_date)} (version {b.version.version}, locked).
              </p>
              {b.permissions.reopen && (
                <button
                  className="btn"
                  onClick={async () => {
                    if (!confirm("Reopen as a new draft version? The finalized version stays locked.")) return;
                    await call(`/api/plans/${b.plan.id}/reopen`, { method: "POST" });
                    await reload();
                  }}
                >
                  Reopen as new version
                </button>
              )}
            </>
          ) : b.permissions.finalize ? (
            <>
              <p className="text-sm text-slate-600">Finalizing locks this version and stamps today as the treatment plan final date. Only the BCBA should finalize, after reviewing every AI-written section.</p>
              <button
                className="btn-primary w-full justify-center"
                disabled={!v || v.length > 0 || !!busy}
                onClick={async () => {
                  if (!confirm("I have reviewed this plan and confirm it is accurate. Finalize now?")) return;
                  setBusy("final");
                  try {
                    await call(`/api/plans/${b.plan.id}/finalize`, { method: "POST" });
                    await reload();
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Finalize plan
              </button>
            </>
          ) : (
            <p className="text-sm text-slate-500">Only the assigned BCBA can finalize this plan.</p>
          )}
        </div>
        {b.permissions.export && (
          <div className="card space-y-2 p-5">
            <h2 className="font-semibold">Export</h2>
            <p className="text-xs text-slate-500">Built from the company Word template with logo, header, footer and signature blocks. {b.plan.status !== "final" && "Drafts are watermarked DRAFT."}</p>
            <div className="flex gap-2">
              <button className="btn" disabled={!!busy} onClick={() => exportAs("docx")}>
                {busy === "docx" ? "Building…" : "Download DOCX"}
              </button>
              <button className="btn" disabled={!!busy} onClick={() => exportAs("pdf")}>
                {busy === "pdf" ? "Building…" : "Download PDF"}
              </button>
            </div>
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </div>
  );
}
