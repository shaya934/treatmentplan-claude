"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { call } from "@/lib/client";
import { useMe } from "@/components/useMe";

export default function NewClient() {
  const me = useMe();
  const router = useRouter();
  const [bcbas, setBcbas] = useState<Array<{ id: string; name: string; credential: string | null }>>([]);
  const [f, setF] = useState({ last: "", first: "", dob: "", gender: "", medicaidId: "", payer: "", diagnosis: "Autism Spectrum Disorder (F84.0)", assignedBcbaId: "" });
  const [err, setErr] = useState("");
  useEffect(() => {
    if (me.user.role !== "bcba") call<typeof bcbas>("/api/bcbas").then(setBcbas);
  }, [me]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      const r = await call<{ id: string }>("/api/clients", {
        body: { name: `${f.last.trim()}, ${f.first.trim()}`, dob: f.dob || null, gender: f.gender || null, medicaidId: f.medicaidId || null, payer: f.payer || null, diagnosis: f.diagnosis || null, assignedBcbaId: f.assignedBcbaId || null },
      });
      router.push(`/clients/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <form onSubmit={save} className="card max-w-2xl space-y-4 p-5">
      <h1 className="text-lg font-semibold">New client</h1>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Last name</label>
          <input className="input" value={f.last} onChange={set("last")} required />
        </div>
        <div>
          <label className="label">First name</label>
          <input className="input" value={f.first} onChange={set("first")} required />
        </div>
        <div>
          <label className="label">Date of birth</label>
          <input className="input" type="date" value={f.dob} onChange={set("dob")} />
        </div>
        <div>
          <label className="label">Gender</label>
          <input className="input" value={f.gender} onChange={set("gender")} />
        </div>
        <div>
          <label className="label">Medicaid ID</label>
          <input className="input" value={f.medicaidId} onChange={set("medicaidId")} />
        </div>
        <div>
          <label className="label">Payer</label>
          <input className="input" value={f.payer} onChange={set("payer")} placeholder="e.g. Trillium" />
        </div>
        <div className="col-span-2">
          <label className="label">Diagnosis</label>
          <input className="input" value={f.diagnosis} onChange={set("diagnosis")} />
        </div>
        {me.user.role !== "bcba" && (
          <div className="col-span-2">
            <label className="label">Assigned BCBA</label>
            <select className="input" value={f.assignedBcbaId} onChange={set("assignedBcbaId")}>
              <option value="">Unassigned</option>
              {bcbas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} {b.credential ? `(${b.credential})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button className="btn-primary">Create client</button>
    </form>
  );
}
