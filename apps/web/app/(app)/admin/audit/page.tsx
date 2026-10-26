"use client";
import { useEffect, useState } from "react";
import { call, fmtDateTime } from "@/lib/client";

interface Row {
  id: number;
  at: string;
  action: string;
  entity: string;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
  user_name: string | null;
  user_email: string | null;
}
const ACTIONS = ["", "login", "login_failed", "logout", "view", "create", "update", "delete", "upload", "download", "export", "finalize", "restore_version", "generate", "chat_edit", "accept_change", "template_publish", "template_rollback", "support_access", "transcribe", "retention_purge"];

/** Append-only audit log search (admins only). */
export default function Audit() {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState({ action: "", entity: "", entityId: "", from: "", to: "" });
  const search = async () => setRows(await call<Row[]>(`/api/admin/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`));
  useEffect(() => {
    search();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <div>
          <label className="label">Action</label>
          <select className="input" value={q.action} onChange={(e) => setQ({ ...q, action: e.target.value })}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a || "any"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Entity</label>
          <input className="input" value={q.entity} onChange={(e) => setQ({ ...q, entity: e.target.value })} placeholder="plan, client, file…" />
        </div>
        <div>
          <label className="label">Entity ID</label>
          <input className="input" value={q.entityId} onChange={(e) => setQ({ ...q, entityId: e.target.value })} />
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} />
        </div>
        <button className="btn-primary" onClick={search}>
          Search
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{fmtDateTime(r.at)}</td>
                <td>{r.user_name ?? "system"}</td>
                <td>
                  <span className="badge bg-slate-100">{r.action}</span>
                </td>
                <td className="font-mono text-xs">
                  {r.entity} {r.entity_id?.slice(0, 8)}
                </td>
                <td className="font-mono text-xs text-slate-500">{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}</td>
                <td className="text-xs text-slate-500">{r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
