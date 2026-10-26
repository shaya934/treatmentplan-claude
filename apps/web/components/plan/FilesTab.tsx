"use client";
import { useRef, useState } from "react";
import { call, fmtDate } from "@/lib/client";
import type { Evidence, PlanBundle } from "@/lib/types";

const CATEGORIES = ["demographic", "diagnosis", "score", "rate", "date", "iep", "medication", "service", "goal", "authorization", "caregiver", "behavior", "other"];
const ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.csv,.xlsx";
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Upload files straight to encrypted storage, then review the extracted evidence table (spec F2). */
export function FilesTab({ b, reload, editable }: { b: PlanBundle; reload: () => Promise<void>; editable: boolean }) {
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Evidence>>({});
  const input = useRef<HTMLInputElement>(null);

  async function uploadAll(list: FileList | File[]) {
    setErr("");
    for (const f of Array.from(list)) {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME[ext];
      if (!mime) {
        setErr(`${f.name}: unsupported type`);
        continue;
      }
      if (f.size > 50 * 1024 * 1024) {
        setErr(`${f.name}: larger than 50 MB`);
        continue;
      }
      setUploads((u) => ({ ...u, [f.name]: "uploading" }));
      try {
        const up = await call<{ fileId: string; url: string; headers: Record<string, string> }>(`/api/plans/${b.plan.id}/files`, { body: { filename: f.name, mime, size: f.size } });
        const res = await fetch(up.url, { method: "PUT", headers: up.headers, body: f });
        if (!res.ok) throw new Error("Upload failed");
        await call(`/api/plans/${b.plan.id}/files/${up.fileId}/complete`, { method: "POST" });
        setUploads((u) => ({ ...u, [f.name]: "extracting" }));
      } catch (e) {
        setUploads((u) => ({ ...u, [f.name]: "failed" }));
        setErr((e as Error).message);
      }
    }
    await reload();
    // poll until extraction finishes
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await call<PlanBundle>(`/api/plans/${b.plan.id}`);
      if (!fresh.files.some((f) => ["pending", "uploaded", "processing"].includes(f.extraction_status))) break;
    }
    setUploads({});
    await reload();
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await call(`/api/plans/${b.plan.id}/evidence/${id}`, { body: p });
    await call(`/api/plans/${b.plan.id}/prefill`, { method: "POST" });
    await reload();
  }

  const byFile = new Map(b.files.map((f) => [f.id, f.filename]));
  return (
    <div className="space-y-5">
      {editable && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            uploadAll(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-sm ${drag ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-white"}`}
        >
          <p className="font-medium">Drop client files here, or click to choose</p>
          <p className="text-slate-500">PDF (typed or scanned), DOCX, images, CSV/XLSX data exports. Max 50 MB each. Files go straight to encrypted storage.</p>
          <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && uploadAll(e.target.files)} />
        </div>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {Object.entries(uploads).length > 0 && (
        <ul className="text-sm text-slate-600">
          {Object.entries(uploads).map(([n, s]) => (
            <li key={n}>
              {n}: {s}…
            </li>
          ))}
        </ul>
      )}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>File</th>
              <th>Pages</th>
              <th>Status</th>
              <th>Uploaded</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {b.files.map((f) => (
              <tr key={f.id}>
                <td>{f.filename}</td>
                <td>{f.pages ?? ""}</td>
                <td>
                  <span className={`badge ${f.extraction_status === "done" ? "bg-emerald-100 text-emerald-800" : f.extraction_status === "failed" || f.extraction_status === "needs_ocr" ? "bg-red-100 text-red-800" : "bg-slate-100"}`}>
                    {f.extraction_status === "needs_ocr" ? "scanned pages need review" : f.extraction_status}
                  </span>
                </td>
                <td>{new Date(f.uploaded_at).toLocaleString()}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn btn-sm" onClick={async () => window.open((await call<{ url: string }>(`/api/files/${f.id}`)).url, "_blank")}>
                    Download
                  </button>{" "}
                  {editable && (
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        if (!confirm(`Remove ${f.filename} and its facts?`)) return;
                        await call(`/api/plans/${b.plan.id}/files/${f.id}/delete`, { method: "POST" });
                        await reload();
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {b.files.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-slate-500">
                  No files yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Extracted facts ({b.evidence.length})</h2>
        <p className="text-sm text-slate-500">Check every fact. Correct or delete anything wrong; pre-fill updates automatically.</p>
        {editable && b.evidence.length > 0 && (
          <button
            className="btn btn-sm ml-auto"
            onClick={async () => {
              await call(`/api/plans/${b.plan.id}/evidence/confirm-all`, { method: "POST" });
              await reload();
            }}
          >
            Mark all checked
          </button>
        )}
        {editable && (
          <button
            className="btn btn-sm"
            onClick={async () => {
              await call(`/api/plans/${b.plan.id}/evidence`, { body: { fact_text: "New fact", category: "other", value: null, unit: null, source_date: null } });
              await reload();
            }}
          >
            + Add fact
          </button>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Fact</th>
              <th>Value</th>
              <th>Unit</th>
              <th>Source date</th>
              <th>Category</th>
              <th>Source</th>
              <th>Checked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {b.evidence.map((e) =>
              editId === e.id ? (
                <tr key={e.id} className="bg-brand-50/40">
                  <td>
                    <input className="input" defaultValue={e.fact_text} onChange={(x) => setDraft({ ...draft, fact_text: x.target.value })} />
                  </td>
                  <td>
                    <input className="input w-24" defaultValue={e.value ?? ""} onChange={(x) => setDraft({ ...draft, value: x.target.value })} />
                  </td>
                  <td>
                    <input className="input w-24" defaultValue={e.unit ?? ""} onChange={(x) => setDraft({ ...draft, unit: x.target.value })} />
                  </td>
                  <td>
                    <input className="input" type="date" defaultValue={e.source_date ?? ""} onChange={(x) => setDraft({ ...draft, source_date: x.target.value })} />
                  </td>
                  <td>
                    <select className="input" defaultValue={e.category} onChange={(x) => setDraft({ ...draft, category: x.target.value as Evidence["category"] })}>
                      {CATEGORIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </td>
                  <td colSpan={2} />
                  <td className="whitespace-nowrap">
                    <button
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        await patch(e.id, { ...draft, confirmed: true });
                        setEditId(null);
                        setDraft({});
                      }}
                    >
                      Save
                    </button>{" "}
                    <button className="btn btn-sm" onClick={() => setEditId(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={e.id}>
                  <td>{e.fact_text}</td>
                  <td className="font-medium">{e.value}</td>
                  <td>{e.unit}</td>
                  <td>{fmtDate(e.source_date)}</td>
                  <td>
                    <span className="badge bg-slate-100">{e.category}</span>
                  </td>
                  <td className="text-xs text-slate-500">{e.file_id ? `${byFile.get(e.file_id) ?? e.filename ?? "file"}, p.${e.page}` : "added by BCBA"}</td>
                  <td>{e.confirmed_by_bcba ? "✓" : ""}</td>
                  <td className="whitespace-nowrap text-right">
                    {editable && (
                      <>
                        <button className="btn btn-sm" onClick={() => (setEditId(e.id), setDraft({}))}>
                          Correct
                        </button>{" "}
                        <button className="btn btn-sm" onClick={() => patch(e.id, { deleted: true })}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
