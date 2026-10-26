"use client";
import { useEffect, useState } from "react";
import { call } from "@/lib/client";

interface Usage {
  byMonth: Array<{ month: string; reports: string; generations: string; cost: string; input_tokens: string; output_tokens: string }>;
  byStep: Array<{ step: string; model: string; calls: string; input_tokens: string; output_tokens: string; cost: string }>;
}

export default function UsagePage() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    call<Usage>("/api/admin/usage").then(setU);
  }, []);
  if (!u) return <p className="text-sm text-slate-500">Loading…</p>;
  const max = Math.max(1, ...u.byMonth.map((m) => Number(m.cost)));
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Usage</h1>
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Reports finalized and AI cost estimate, last 12 months</h2>
        <table className="tbl">
          <thead>
            <tr>
              <th>Month</th>
              <th>Reports finalized</th>
              <th>Plans generated</th>
              <th>Tokens (in / out)</th>
              <th className="w-1/3">AI cost (est.)</th>
            </tr>
          </thead>
          <tbody>
            {u.byMonth.map((m) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td>{m.reports}</td>
                <td>{m.generations}</td>
                <td className="text-xs">
                  {Number(m.input_tokens).toLocaleString()} / {Number(m.output_tokens).toLocaleString()}
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-2 rounded bg-brand-500" style={{ width: `${(Number(m.cost) / max) * 100}%`, minWidth: Number(m.cost) > 0 ? 2 : 0 }} />
                    <span className="text-xs">${Number(m.cost).toFixed(2)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Last 30 days by step and model</h2>
        <table className="tbl">
          <thead>
            <tr>
              <th>Step</th>
              <th>Model</th>
              <th>Calls</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
              <th>Cost (est.)</th>
            </tr>
          </thead>
          <tbody>
            {u.byStep.map((s) => (
              <tr key={s.step + s.model}>
                <td>{s.step}</td>
                <td className="font-mono text-xs">{s.model}</td>
                <td>{s.calls}</td>
                <td>{Number(s.input_tokens).toLocaleString()}</td>
                <td>{Number(s.output_tokens).toLocaleString()}</td>
                <td>${Number(s.cost).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
