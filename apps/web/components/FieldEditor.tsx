"use client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
import type { Field, FieldEntry, FieldValue, TableRow } from "@/lib/types";

/** One template field in the document-style editor: read view, click to edit, save on blur. */

const STATUS: Record<string, [string, string]> = {
  prefilled: ["Pre-filled from files", "bg-sky-100 text-sky-800"],
  needs_bcba: ["Needs BCBA", "bg-amber-100 text-amber-800"],
  calculated: ["Calculated", "bg-violet-100 text-violet-800"],
  complete: ["Complete", "bg-emerald-100 text-emerald-800"],
  carried_forward: ["Carried forward – confirm", "bg-orange-100 text-orange-800"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, "bg-slate-100"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[BCBA to confirm:[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[BCBA to confirm:") ? (
          <mark key={i} className="placeholder-chip rounded px-0.5 text-amber-900">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function textToHtml(t: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function NarrativeEditor({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, blockquote: false, horizontalRule: false })],
    content: textToHtml(value),
    immediatelyRender: false,
    autofocus: "end",
    onBlur: ({ editor }) => onDone(editor.getText({ blockSeparator: "\n\n" }).trim()),
  });
  return (
    <div className="rounded-md border border-brand-500 bg-white px-2.5 py-1.5 text-sm ring-1 ring-brand-500">
      <EditorContent editor={editor} />
    </div>
  );
}

function TableEditor({ field, rows, readOnly, onChange }: { field: Field; rows: TableRow[]; readOnly: boolean; onChange: (rows: TableRow[]) => void }) {
  const cols = field.columns!;
  const [local, setLocal] = useState(rows);
  useEffect(() => setLocal(rows), [rows]);
  const fixed = !!field.fixedRows?.length;
  const commit = (next: TableRow[]) => {
    setLocal(next);
    onChange(next);
  };
  return (
    <div className="overflow-x-auto">
      <table className="tbl border border-slate-200">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id}>{c.label}</th>
            ))}
            {!fixed && !readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {local.map((r, i) => (
            <tr key={i}>
              {cols.map((c, ci) => (
                <td key={c.id} className="min-w-[90px] p-0.5">
                  {readOnly || (fixed && ci === 0) ? (
                    <div className={`px-1.5 py-1 ${fixed && ci === 0 ? "font-medium text-slate-700" : ""}`}>
                      <Highlighted text={r[c.id] ?? ""} />
                    </div>
                  ) : c.type === "select" && c.options ? (
                    <select className="input py-1" value={r[c.id] ?? ""} onChange={(e) => commit(local.map((x, j) => (j === i ? { ...x, [c.id]: e.target.value } : x)))}>
                      <option value="" />
                      {c.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <textarea
                      rows={c.type === "narrative" ? 3 : 1}
                      className={`input resize-y py-1 ${/\[BCBA to confirm/.test(r[c.id] ?? "") ? "placeholder-chip" : ""}`}
                      value={r[c.id] ?? ""}
                      onChange={(e) => setLocal(local.map((x, j) => (j === i ? { ...x, [c.id]: e.target.value } : x)))}
                      onBlur={() => JSON.stringify(local) !== JSON.stringify(rows) && onChange(local)}
                    />
                  )}
                </td>
              ))}
              {!fixed && !readOnly && (
                <td className="p-0.5">
                  <button className="btn btn-sm" title="Remove row" onClick={() => commit(local.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!fixed && !readOnly && (
        <button className="btn btn-sm mt-1" onClick={() => commit([...local, Object.fromEntries(cols.map((c) => [c.id, ""]))])}>
          + Add row
        </button>
      )}
    </div>
  );
}

export function FieldEditor({
  field,
  entry,
  readOnly,
  vars,
  onSave,
  onSelect,
  selected,
  highlighted,
}: {
  field: Field;
  entry: FieldEntry | undefined;
  readOnly: boolean;
  vars: Record<string, string>;
  onSave: (value: FieldValue) => void;
  onSelect: () => void;
  selected: boolean;
  highlighted?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const v = entry?.value ?? null;

  if (field.type === "static") {
    const text = (field.text ?? "").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] || `[${k.replace(/_/g, " ")}]`);
    return <p className="my-2 text-sm text-slate-600">{text}</p>;
  }

  const header = (
    <div className="mb-1 flex items-start gap-2">
      <div className="text-sm font-semibold text-slate-700">
        {field.label}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">{entry && <StatusBadge status={entry.status} />}</div>
    </div>
  );

  let body: React.ReactNode;
  if (field.type === "table") {
    body = <TableEditor field={field} rows={(v as TableRow[]) ?? []} readOnly={readOnly} onChange={(rows) => onSave(rows)} />;
  } else if (field.type === "boolean") {
    body = (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={readOnly} checked={v === true} onChange={(e) => onSave(e.target.checked)} /> Yes
      </label>
    );
  } else if (field.type === "multiselect") {
    const sel = new Set((v as string[]) ?? []);
    body = (
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(field.options ?? []).map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={sel.has(o)}
              onChange={(e) => {
                const next = new Set(sel);
                if (e.target.checked) next.add(o);
                else next.delete(o);
                onSave(Array.from(next));
              }}
            />
            {o}
          </label>
        ))}
      </div>
    );
  } else if (field.type === "select") {
    body = (
      <select className="input max-w-md" disabled={readOnly} value={String(v ?? "")} onChange={(e) => onSave(e.target.value)}>
        <option value="" />
        {!field.options?.includes(String(v ?? "")) && v ? <option value={String(v)}>{String(v)}</option> : null}
        {field.options?.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (editing && !readOnly) {
    body =
      field.type === "narrative" ? (
        <NarrativeEditor
          value={String(v ?? "")}
          onDone={(t) => {
            setEditing(false);
            if (t !== String(v ?? "")) onSave(t);
          }}
        />
      ) : (
        <input
          autoFocus
          className="input"
          defaultValue={String(v ?? "")}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== String(v ?? "")) onSave(e.target.value);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      );
  } else {
    const text = String(v ?? "");
    body = (
      <div
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        onClick={() => !readOnly && setEditing(true)}
        onKeyDown={(e) => e.key === "Enter" && !readOnly && setEditing(true)}
        className={`min-h-[2rem] whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-sm ${readOnly ? "" : "cursor-text hover:bg-slate-50 hover:ring-1 hover:ring-slate-200"} ${text ? "" : "italic text-slate-400"}`}
      >
        {text ? <Highlighted text={text} /> : readOnly ? "—" : "Click to type"}
      </div>
    );
  }

  return (
    <div id={`field-${field.id}`} onClick={onSelect} className={`rounded-md border px-3 py-2 transition ${selected ? "border-brand-500 bg-brand-50/40" : "border-transparent"} ${highlighted ? "ring-2 ring-amber-400" : ""}`}>
      {header}
      {field.help && <p className="mb-1 text-xs text-slate-500">{field.help}</p>}
      {body}
    </div>
  );
}
