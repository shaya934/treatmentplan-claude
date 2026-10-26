"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { call, fmtDate, fmtDateTime } from "@/lib/client";
import { wordDiff } from "@/lib/diff";
import { FieldEditor, Highlighted } from "@/components/FieldEditor";
import { VoiceButton } from "@/components/VoiceButton";
import type { Change, FieldValue, PlanBundle, PlanContent, TableRow } from "@/lib/types";

/** Document-style plan editor with side chat, review list, source key and version history (spec F6, F7). */

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((r) => (typeof r === "object" ? Object.values(r as TableRow).filter(Boolean).join(" | ") : String(r))).join("\n");
  return String(v);
}

function TableDiff({ before, after }: { before: TableRow[]; after: TableRow[] }) {
  const n = Math.max(before.length, after.length);
  const rows: Array<{ label: string; cells: Array<{ col: string; a: string; b: string }> }> = [];
  for (let i = 0; i < n; i++) {
    const a = before[i] ?? {};
    const b = after[i] ?? {};
    const cols = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
    const cells = cols.filter((c) => (a[c] ?? "") !== (b[c] ?? "")).map((c) => ({ col: c, a: a[c] ?? "", b: b[c] ?? "" }));
    if (cells.length) rows.push({ label: Object.values(b)[0] || Object.values(a)[0] || `Row ${i + 1}`, cells });
  }
  return (
    <div className="rounded border border-slate-200 bg-white p-2 text-xs">
      {rows.length === 0 && <span className="text-slate-500">No visible change</span>}
      {rows.map((r, i) => (
        <div key={i}>
          <b>{r.label}</b>:{" "}
          {r.cells.map((c) => (
            <span key={c.col} className="mr-2">
              {c.col.replace(/_/g, " ")} <span className="bg-red-100 text-red-800 line-through">{c.a || "∅"}</span> → <span className="bg-emerald-100 text-emerald-900">{c.b || "∅"}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Diff({ before, after }: { before: unknown; after: unknown }) {
  const isRows = (v: unknown) => Array.isArray(v) && (v.length === 0 || typeof v[0] === "object");
  if (isRows(before) && isRows(after)) return <TableDiff before={before as TableRow[]} after={after as TableRow[]} />;
  const pieces = wordDiff(asText(before), asText(after));
  return (
    <div className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 text-xs leading-relaxed">
      {pieces.map((p, i) => (
        <span key={i} className={p.kind === "add" ? "bg-emerald-100 text-emerald-900" : p.kind === "del" ? "bg-red-100 text-red-800 line-through" : ""}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

function ChangeList({ changes, decided, onDecide, flags }: { changes: Change[]; decided: Record<string, string>; onDecide?: (accept: string[], reject: string[]) => void; flags?: Array<{ fieldId: string; reason: string }> }) {
  const [sel, setSel] = useState<Record<string, boolean>>(() => Object.fromEntries(changes.map((c) => [c.id, true])));
  const open = changes.filter((c) => !decided[c.id]);
  return (
    <div className="space-y-2">
      {changes.map((c) => (
        <div key={c.id} className="rounded-md border border-slate-200 bg-slate-50 p-2">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-semibold">{c.fieldLabel.split("(")[0]}</span>
            {c.linked && <span className="badge bg-violet-100 text-violet-800">linked field</span>}
            {decided[c.id] ? (
              <span className={`badge ml-auto ${decided[c.id] === "accepted" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200"}`}>{decided[c.id]}</span>
            ) : (
              onDecide && (
                <label className="ml-auto flex items-center gap-1">
                  <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => setSel({ ...sel, [c.id]: e.target.checked })} /> accept
                </label>
              )
            )}
          </div>
          <p className="mb-1 text-xs text-slate-500">{c.summary}</p>
          <Diff before={c.before} after={c.after} />
        </div>
      ))}
      {flags?.map((f, i) => (
        <div key={i} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <b>Flagged as mismatched:</b> {f.reason}
        </div>
      ))}
      {onDecide && open.length > 0 && (
        <div className="flex gap-2">
          <button className="btn-primary btn-sm" onClick={() => onDecide(open.filter((c) => sel[c.id]).map((c) => c.id), open.filter((c) => !sel[c.id]).map((c) => c.id))}>
            Apply selected
          </button>
          <button className="btn btn-sm" onClick={() => onDecide([], open.map((c) => c.id))}>
            Reject all
          </button>
        </div>
      )}
    </div>
  );
}

const KIND_ORDER = ["conflict", "mismatch", "unsupported", "needs_ocr", "carried_forward", "low_input", "placeholder"];

interface ChatMsg {
  id: string;
  role: string;
  content: string;
  metadata: { proposal?: { changes: Change[]; flags: Array<{ fieldId: string; reason: string }> }; decisionFor?: string; decided?: Record<string, string>; mode?: string };
  created_at: string;
}

export function EditorTab({ b, reload, editable }: { b: PlanBundle; reload: () => Promise<void>; editable: boolean }) {
  const [content, setContent] = useState<PlanContent>(b.version.content_json);
  const [streaming, setStreaming] = useState<string[] | null>(b.plan.generation_status === "running" ? [] : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"chat" | "review" | "source" | "versions">("review");
  const [linked, setLinked] = useState<Array<{ group: string; changes: Change[]; flagged: Array<{ fieldId: string; reason: string }> }> | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [req, setReq] = useState("");
  const [reqMode, setReqMode] = useState<"typed" | "voice">("typed");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [versions, setVersions] = useState<Array<{ version: number; created_by_name: string | null; created_at: string; change_summary: string; locked: boolean }>>([]);
  const [viewVersion, setViewVersion] = useState<{ version: number; content: PlanContent } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [kind, setKind] = useState("all");

  useEffect(() => setContent(b.version.content_json), [b.version]);

  const loadChat = useCallback(async () => setMsgs(await call<ChatMsg[]>(`/api/plans/${b.plan.id}/chat`)), [b.plan.id]);
  const loadVersions = useCallback(async () => setVersions(await call(`/api/plans/${b.plan.id}/versions`)), [b.plan.id]);
  useEffect(() => {
    loadChat();
  }, [loadChat]);
  useEffect(() => {
    if (panel === "versions") loadVersions();
  }, [panel, loadVersions, b.version.version]);

  // Stream generation section by section.
  const listen = useCallback(() => {
    const es = new EventSource(`/api/plans/${b.plan.id}/stream`);
    setStreaming([]);
    es.onmessage = (m) => {
      const d = JSON.parse(m.data) as { status: string; generated: string[]; content: PlanContent | null };
      setStreaming(d.generated);
      if (d.content) setContent(d.content);
      if (d.status !== "running") {
        es.close();
        setStreaming(null);
        reload();
      }
    };
    es.onerror = () => {
      es.close();
      setStreaming(null);
      reload();
    };
  }, [b.plan.id, reload]);
  useEffect(() => {
    if (b.plan.generation_status === "running") listen();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate() {
    if (b.plan.current_version > 1 && !confirm("Generate the draft now? Fields you completed yourself are kept; other fields are rewritten from the files and your answers.")) return;
    setErr("");
    try {
      await call(`/api/plans/${b.plan.id}/generate`, { method: "POST" });
      listen();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function saveField(fieldId: string, value: FieldValue) {
    setErr("");
    setContent((c) => ({ ...c, [fieldId]: { ...(c[fieldId] ?? { sources: [] }), value, status: "complete" } as PlanContent[string] }));
    try {
      const r = await call<{ version: number; linked: typeof linked }>(`/api/plans/${b.plan.id}/fields`, { body: { edits: { [fieldId]: value } } });
      if (r.linked && r.linked.some((g) => g.changes.length || g.flagged.length)) setLinked(r.linked);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
      setContent(b.version.content_json);
    }
  }

  async function applyLinked(accept: string[]) {
    const changes = (linked ?? []).flatMap((g) => g.changes).filter((c) => accept.includes(c.id));
    if (changes.length) await call(`/api/plans/${b.plan.id}/fields`, { body: { edits: Object.fromEntries(changes.map((c) => [c.fieldId, c.after])), summary: "Updated linked fields after confirmation" } });
    setLinked(null);
    await reload();
  }

  async function sendChat(e?: React.FormEvent) {
    e?.preventDefault();
    if (!req.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await call(`/api/plans/${b.plan.id}/chat`, { body: { request: req, mode: reqMode } });
      setReq("");
      setReqMode("typed");
      await loadChat();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const decisions = useMemo(() => {
    const d: Record<string, Record<string, string>> = {};
    for (const m of msgs) if (m.metadata.decisionFor) d[m.metadata.decisionFor] = { ...(d[m.metadata.decisionFor] ?? {}), ...(m.metadata.decided ?? {}) };
    return d;
  }, [msgs]);

  const evById = useMemo(() => new Map(b.evidence.map((e) => [e.id, e])), [b.evidence]);
  const fileName = useMemo(() => new Map(b.files.map((f) => [f.id, f.filename])), [b.files]);
  const openReview = b.review.filter((r) => !r.resolved_at);
  const sel = selected ? b.template.sections.flatMap((s) => s.fields).find((f) => f.id === selected) : null;
  const shown = viewVersion?.content ?? content;

  function jump(fieldId: string | null) {
    if (!fieldId) return;
    setSelected(fieldId);
    setFlash(fieldId);
    document.getElementById(`field-${fieldId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setFlash(null), 1600);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <button className="btn-primary" onClick={generate} disabled={streaming !== null}>
              {streaming !== null ? `Generating… ${streaming.length}/${b.template.sections.length} sections` : b.plan.progress.generatedAt ? "Regenerate draft" : "Generate draft"}
            </button>
          )}
          {b.plan.progress.generatedAt && <span className="text-xs text-slate-500">Last generated {fmtDateTime(b.plan.progress.generatedAt)}</span>}
          {viewVersion && (
            <div className="flex items-center gap-2 rounded bg-amber-100 px-2 py-1 text-sm text-amber-900">
              Viewing version {viewVersion.version} (read-only)
              {editable && (
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    await call(`/api/plans/${b.plan.id}/restore`, { body: { version: viewVersion.version } });
                    setViewVersion(null);
                    await reload();
                  }}
                >
                  Restore this version
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setViewVersion(null)}>
                Back to current
              </button>
            </div>
          )}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
        <div className="card divide-y divide-slate-100">
          {b.template.sections.map((s) => (
            <section key={s.id} className={`p-4 ${streaming && !streaming.includes(s.id) ? "opacity-50" : ""}`}>
              <h2 className="mb-2 rounded bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white">{s.title}</h2>
              {s.intro && <p className="mb-2 text-xs italic text-slate-500">{s.intro}</p>}
              <div className="space-y-1">
                {s.fields.map((f) => (
                  <FieldEditor
                    key={f.id + (viewVersion?.version ?? "")}
                    field={f}
                    entry={shown[f.id]}
                    vars={b.vars}
                    readOnly={!editable || !!viewVersion || streaming !== null}
                    selected={selected === f.id}
                    highlighted={flash === f.id}
                    onSelect={() => {
                      setSelected(f.id);
                      if (panel === "review" && !openReview.some((r) => r.field_id === f.id)) setPanel("source");
                    }}
                    onSave={(v) => saveField(f.id, v)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <aside className="xl:sticky xl:top-3 xl:h-[calc(100vh-1.5rem)]">
        <div className="card flex h-full flex-col overflow-hidden">
          <div className="flex border-b border-slate-200 text-sm">
            {(
              [
                ["review", `Review (${openReview.length})`],
                ["chat", "Chat edits"],
                ["source", "Source key"],
                ["versions", "Versions"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setPanel(k)} className={`flex-1 px-2 py-2 ${panel === k ? "border-b-2 border-brand-600 font-semibold text-brand-700" : "text-slate-600"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {panel === "review" && (
              <div className="space-y-2">
                {b.review.length === 0 && <p className="text-sm text-slate-500">Nothing to review yet. Generate a draft to build the review list.</p>}
                <div className="flex flex-wrap gap-1 text-xs">
                  {["all", ...Array.from(new Set(b.review.map((r) => r.kind)))].map((k) => (
                    <button key={k} onClick={() => setKind(k)} className={`badge ${kind === k ? "bg-brand-600 text-white" : "bg-slate-100"}`}>
                      {k.replace("_", " ")} {k === "all" ? openReview.length : b.review.filter((r) => r.kind === k && !r.resolved_at).length}
                    </button>
                  ))}
                </div>
                {[...b.review]
                  .filter((r) => kind === "all" || r.kind === kind)
                  .sort((x, y) => Number(!!x.resolved_at) - Number(!!y.resolved_at) || KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind))
                  .map((r) => (
                  <div key={r.id} className={`rounded-md border p-2 text-sm ${r.resolved_at ? "border-slate-200 opacity-60" : r.kind === "conflict" || r.kind === "mismatch" ? "border-red-300 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <span className="badge bg-white">{r.kind.replace("_", " ")}</span>
                      {r.field_id && (
                        <button className="text-brand-600 underline" onClick={() => jump(r.field_id)}>
                          go to field
                        </button>
                      )}
                      {editable && r.kind !== "placeholder" && (
                        <button
                          className="btn btn-sm ml-auto"
                          onClick={async () => {
                            await call(`/api/plans/${b.plan.id}/review/${r.id}`, { body: { resolved: !r.resolved_at } });
                            await reload();
                          }}
                        >
                          {r.resolved_at ? "Reopen" : "Mark resolved"}
                        </button>
                      )}
                    </div>
                    <Highlighted text={r.detail} />
                  </div>
                ))}
                <p className="pt-2 text-xs text-slate-500">Placeholders resolve when you replace them in the plan. Conflicts, carried-forward items and mismatches need a decision before finalizing.</p>
              </div>
            )}
            {panel === "chat" && (
              <div className="flex h-full flex-col">
                <div className="flex-1 space-y-3">
                  {msgs.length === 0 && <p className="text-sm text-slate-500">Ask for edits in plain language, e.g. “Make the aggression BIP more detailed” or “Change 97153 to 12 hrs/week”. Only the targeted fields change, and you accept or reject each change.</p>}
                  {msgs
                    .filter((m) => m.role !== "system")
                    .map((m) => (
                      <div key={m.id} className={m.role === "user" ? "ml-8" : "mr-2"}>
                        <div className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-brand-600 text-white" : "bg-slate-100"}`}>{m.content}</div>
                        {m.metadata.proposal && m.metadata.proposal.changes.length + m.metadata.proposal.flags.length > 0 && (
                          <div className="mt-2">
                            <ChangeList
                              changes={m.metadata.proposal.changes}
                              flags={m.metadata.proposal.flags}
                              decided={decisions[m.id] ?? {}}
                              onDecide={
                                editable
                                  ? async (accept, reject) => {
                                      await call(`/api/plans/${b.plan.id}/chat/decide`, { body: { messageId: m.id, accept, reject } });
                                      await loadChat();
                                      await reload();
                                    }
                                  : undefined
                              }
                            />
                          </div>
                        )}
                      </div>
                    ))}
                </div>
                {editable && (
                  <form onSubmit={sendChat} className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                    <textarea className="input min-h-[70px]" placeholder="Describe the edit…" value={req} onChange={(e) => setReq(e.target.value)} />
                    <div className="flex gap-2">
                      <VoiceButton
                        disabled={busy}
                        onText={(t) => {
                          setReq((x) => (x ? `${x} ${t}` : t));
                          setReqMode("voice");
                        }}
                      />
                      <button className="btn-primary ml-auto" disabled={busy || !req.trim()}>
                        {busy ? "Thinking…" : "Send"}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {panel === "source" && (
              <div className="space-y-2 text-sm">
                {!sel && <p className="text-slate-500">Click a field to see where its content came from.</p>}
                {sel && (
                  <>
                    <div className="font-semibold">{sel.label}</div>
                    {(() => {
                      const e = content[sel.id];
                      if (!e) return <p className="text-slate-500">No content.</p>;
                      const srcLabel = (s: string) => {
                        const ev = evById.get(s);
                        if (ev) return `${ev.fact_text}: ${ev.value ?? ""} ${ev.unit ?? ""} — ${ev.file_id ? `${fileName.get(ev.file_id) ?? "file"} p.${ev.page}` : "added by BCBA"}${ev.source_date ? ` (${fmtDate(ev.source_date)})` : ""}`;
                        if (s.startsWith("bcba_answer:")) return `BCBA answer to question ${s.slice(12)}`;
                        return { client_record: "Client record", user_record: "BCBA profile", plan_record: "Plan record", previous_plan: "Previous finalized plan (carried forward)", bcba_edit: "Edited by BCBA" }[s] ?? s;
                      };
                      return (
                        <>
                          {e.sentenceSources?.length ? (
                            <ol className="list-decimal space-y-2 pl-4">
                              {e.sentenceSources.map((s, i) => (
                                <li key={i}>
                                  <div>{s.sentence}</div>
                                  <div className="text-xs text-slate-500">{s.sources.length ? s.sources.map(srcLabel).join("; ") : "No source (placeholder or BCBA to confirm)"}</div>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <ul className="list-disc space-y-1 pl-4 text-xs text-slate-600">
                              {e.sources.length ? e.sources.map((s) => <li key={s}>{srcLabel(s)}</li>) : <li>No source recorded.</li>}
                            </ul>
                          )}
                        </>
                      );
                    })()}
                  </>
                )}
              </div>
            )}
            {panel === "versions" && (
              <ul className="space-y-1 text-sm">
                {versions.map((v) => (
                  <li key={v.version} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-slate-50">
                    <span className="font-mono text-xs text-slate-500">v{v.version}</span>
                    <div className="flex-1">
                      <div>{v.change_summary || "Saved"}</div>
                      <div className="text-xs text-slate-500">
                        {v.created_by_name ?? "System"} · {fmtDateTime(v.created_at)} {v.locked && <span className="badge bg-emerald-100 text-emerald-800">final, locked</span>}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        const r = await call<{ version: number; content_json: PlanContent }>(`/api/plans/${b.plan.id}/versions/${v.version}`);
                        setViewVersion({ version: r.version, content: r.content_json });
                      }}
                    >
                      View
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>

      {linked && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5">
            <h3 className="mb-1 font-semibold">Update linked fields?</h3>
            <p className="mb-3 text-sm text-slate-600">These fields are linked in the template. Accept to keep them consistent, or leave them; mismatches are flagged before finalizing.</p>
            <ChangeList changes={linked.flatMap((g) => g.changes)} flags={linked.flatMap((g) => g.flagged)} decided={{}} onDecide={(accept) => applyLinked(accept)} />
            <button className="btn mt-3" onClick={() => setLinked(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
