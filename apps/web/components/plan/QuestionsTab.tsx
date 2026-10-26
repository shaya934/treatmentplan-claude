"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { call } from "@/lib/client";
import { VoiceButton } from "@/components/VoiceButton";
import type { PlanBundle } from "@/lib/types";

interface Q {
  id: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  prompt: string;
  known: string | null;
  status: "answered_by_files" | "partial" | "open" | "answered" | "skipped";
  answers: Array<{ answer_text: string; input_mode: string; created_at: string }>;
}

/** Guided question chat (spec F4): one question at a time, grouped by section, with progress, skip/back/jump, voice. */
export function QuestionsTab({ b, editable, onDone }: { b: PlanBundle; editable: boolean; onDone: () => void }) {
  const [qs, setQs] = useState<Q[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ content: string; metadata: { questionId?: string }; created_at: string }>>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"typed" | "voice">("typed");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await call<{ questions: Q[]; current: string | null; messages: typeof messages }>(`/api/plans/${b.plan.id}/questions`);
    setQs(r.questions);
    setCurrent((c) => c ?? r.current ?? r.questions[0]?.id ?? null);
    setMessages(r.messages);
  }, [b.plan.id]);
  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo(() => {
    const m = new Map<string, Q[]>();
    for (const q of qs) m.set(q.sectionTitle, [...(m.get(q.sectionTitle) ?? []), q]);
    return Array.from(m.entries());
  }, [qs]);
  const done = qs.filter((q) => q.status === "answered" || q.status === "answered_by_files" || q.status === "skipped").length;
  const q = qs.find((x) => x.id === current);
  const idx = qs.findIndex((x) => x.id === current);

  async function go(id: string) {
    setCurrent(id);
    setText("");
    setErr("");
    if (editable) await call(`/api/plans/${b.plan.id}/question`, { body: { questionId: id } });
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q || !text.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await call<{ complete: boolean; followUp: string | null; next: string | null }>(`/api/plans/${b.plan.id}/answer`, { body: { questionId: q.id, text, mode } });
      setText("");
      setMode("typed");
      await load();
      if (r.complete && r.next) setCurrent(r.next);
      else if (r.complete && !r.next) setCurrent(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const thread = q
    ? [
        ...q.answers.map((a) => ({ who: "bcba" as const, text: a.answer_text, at: a.created_at, mode: a.input_mode })),
        ...messages.filter((m) => m.metadata.questionId === q.id).map((m) => ({ who: "ai" as const, text: m.content, at: m.created_at, mode: "" })),
      ].sort((x, y) => x.at.localeCompare(y.at))
    : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <aside className="card h-fit max-h-[75vh] overflow-y-auto p-3">
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Progress</span>
            <span>
              {done}/{qs.length}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${qs.length ? (done / qs.length) * 100 : 0}%` }} />
          </div>
        </div>
        {sections.map(([title, list]) => (
          <div key={title} className="mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
            {list.map((x) => (
              <button key={x.id} onClick={() => go(x.id)} className={`flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs ${x.id === current ? "bg-brand-50 text-brand-700" : "hover:bg-slate-50"}`}>
                <span className="mt-0.5">{x.status === "answered" ? "●" : x.status === "answered_by_files" ? "◆" : x.status === "skipped" ? "–" : x.status === "partial" ? "◐" : "○"}</span>
                <span className="line-clamp-2">{x.text}</span>
              </button>
            ))}
          </div>
        ))}
        <p className="mt-2 text-[11px] text-slate-500">● answered · ◆ answered by files (skipped automatically) · ◐ partly known · – skipped</p>
      </aside>
      <section className="space-y-4">
        {!q ? (
          <div className="card p-6 text-center">
            <p className="font-medium">All questions are done.</p>
            <p className="text-sm text-slate-500">You can go back to any question, or generate the draft.</p>
            <button className="btn-primary mt-3" onClick={onDone}>
              Go to draft
            </button>
          </div>
        ) : (
          <div className="card space-y-4 p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {q.sectionTitle} · Question {idx + 1} of {qs.length}
            </div>
            {q.known && q.status !== "answered" && <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">From the files: {q.known}</div>}
            <p className="text-base font-medium">{q.status === "partial" ? `Anything to add or correct? ${q.text}` : q.text}</p>
            {q.status === "answered_by_files" && <p className="text-sm text-slate-500">The files already answer this. Add anything you want, or move on.</p>}
            <div className="space-y-2">
              {thread.map((m, i) => (
                <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.who === "bcba" ? "ml-auto bg-brand-600 text-white" : "bg-slate-100"}`}>
                  {m.text}
                  {m.mode === "voice" && <span className="ml-1 text-[10px] opacity-70">(voice)</span>}
                </div>
              ))}
            </div>
            {editable && (
              <form onSubmit={send} className="space-y-2">
                <textarea
                  className="input min-h-[96px]"
                  placeholder="Type your answer, or use the mic. You can correct the transcript before sending."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                  }}
                />
                <div className="flex items-start gap-2">
                  <VoiceButton
                    disabled={busy}
                    onText={(t) => {
                      setText((x) => (x ? `${x} ${t}` : t));
                      setMode("voice");
                    }}
                  />
                  <button className="btn-primary" disabled={busy || !text.trim()}>
                    {busy ? "Saving…" : "Send"}
                  </button>
                  <div className="ml-auto flex gap-2">
                    <button type="button" className="btn" disabled={idx <= 0} onClick={() => go(qs[idx - 1]!.id)}>
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const r = await call<{ current: string | null }>(`/api/plans/${b.plan.id}/question`, { body: { questionId: q.id, skip: true } });
                        await load();
                        setCurrent(r.current ?? qs[idx + 1]?.id ?? null);
                      }}
                    >
                      Skip
                    </button>
                    <button type="button" className="btn" disabled={idx >= qs.length - 1} onClick={() => go(qs[idx + 1]!.id)}>
                      Next
                    </button>
                  </div>
                </div>
                {err && <p className="text-sm text-red-600">{err}</p>}
                <p className="text-xs text-slate-500">Answers save automatically. You can stop and resume on any device.</p>
              </form>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
