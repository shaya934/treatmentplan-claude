"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { call, fmtDate } from "@/lib/client";
import { useMe } from "@/components/useMe";

interface Row {
  id: string;
  name: string;
  dob: string | null;
  payer: string | null;
  bcba_name: string | null;
  auth_end_date: string | null;
  latest_plan_id: string | null;
  latest_plan_status: string | null;
  latest_plan_type: string | null;
}

export default function Clients() {
  const me = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    call<Row[]>("/api/clients").then(setRows);
  }, []);
  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>;
  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Clients</h1>
        <input className="input max-w-xs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        {me.can["client.create"] && (
          <Link href="/clients/new" className="btn-primary ml-auto">
            New client
          </Link>
        )}
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>DOB</th>
              <th>Payer</th>
              <th>BCBA</th>
              <th>Authorization ends</th>
              <th>Latest plan</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/clients/${r.id}`} className="text-brand-600 hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td>{fmtDate(r.dob)}</td>
                <td>{r.payer}</td>
                <td>{r.bcba_name}</td>
                <td>{fmtDate(r.auth_end_date)}</td>
                <td>
                  {r.latest_plan_id ? (
                    <Link href={`/plans/${r.latest_plan_id}`} className="text-brand-600 hover:underline capitalize">
                      {r.latest_plan_type} · {r.latest_plan_status}
                    </Link>
                  ) : (
                    <span className="text-slate-400">none</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
