"use client";
import { useEffect, useState } from "react";
import { call } from "@/lib/client";
import { useMe } from "@/components/useMe";

interface U {
  id: string;
  email: string;
  role: string;
  name: string;
  credential: string | null;
  npi: string | null;
  active: boolean;
  mfa: boolean;
}
const ROLES = ["company_admin", "clinical_director", "bcba", "read_only"];

export default function Users() {
  const me = useMe();
  const [users, setUsers] = useState<U[]>([]);
  const [f, setF] = useState({ email: "", name: "", role: "bcba", credential: "", npi: "", tempPassword: "" });
  const [err, setErr] = useState("");
  const load = () => call<U[]>("/api/admin/users").then(setUsers);
  useEffect(() => {
    load();
  }, []);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await call("/api/admin/users", { body: f });
      setF({ email: "", name: "", role: "bcba", credential: "", npi: "", tempPassword: "" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Credential</th>
              <th>NPI</th>
              <th>MFA</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select className="input py-1" value={u.role} disabled={u.id === me.user.id} onChange={async (e) => (await call(`/api/admin/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), load())}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {/* A company admin with a BCBA credential can also start, edit and finalize plans (rbac.ts). */}
                  <input
                    className="input w-28 py-1"
                    defaultValue={u.credential ?? ""}
                    placeholder="e.g. BCBA"
                    onBlur={async (e) => {
                      const v = e.target.value.trim();
                      if (v !== (u.credential ?? "")) (await call(`/api/admin/users/${u.id}`, { method: "PATCH", body: { credential: v } }), load());
                    }}
                  />
                </td>
                <td>{u.npi}</td>
                <td>{u.mfa ? "✓" : "pending"}</td>
                <td>
                  <input type="checkbox" checked={u.active} disabled={u.id === me.user.id} onChange={async (e) => (await call(`/api/admin/users/${u.id}`, { method: "PATCH", body: { active: e.target.checked } }), load())} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={add} className="card grid gap-3 p-4 md:grid-cols-6">
        <h2 className="font-semibold md:col-span-6">Add user</h2>
        <input className="input md:col-span-2" placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <input className="input md:col-span-2" placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r.replace("_", " ")}
            </option>
          ))}
        </select>
        <input className="input" placeholder="Credential (BCBA)" value={f.credential} onChange={(e) => setF({ ...f, credential: e.target.value })} />
        <input className="input" placeholder="NPI" value={f.npi} onChange={(e) => setF({ ...f, npi: e.target.value })} />
        {me.mode === "local" && <input className="input md:col-span-2" placeholder="Temporary password (12+ chars)" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} required />}
        <button className="btn-primary md:col-span-1">Add</button>
        <p className="text-xs text-slate-500 md:col-span-6">{me.mode === "aws" ? "Cognito emails a temporary password. MFA setup is required at first sign-in." : "The user sets up MFA at first sign-in."}</p>
        {err && <p className="text-sm text-red-600 md:col-span-6">{err}</p>}
      </form>
    </div>
  );
}
