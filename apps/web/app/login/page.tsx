"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { call } from "@/lib/client";

type Step = { step: "password" } | { step: "mfa"; challenge: string } | { step: "mfa_setup"; challenge: string; otpauthUri: string; secret: string };

export default function Login() {
  const [step, setStep] = useState<Step>({ step: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => setExpired(new URLSearchParams(window.location.search).has("expired")), []);
  useEffect(() => {
    if (step.step === "mfa_setup") QRCode.toDataURL(step.otpauthUri, { margin: 1, width: 180 }).then(setQr);
  }, [step]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (step.step === "password") {
        const r = await call<Step | { step: "done" }>("/api/auth/login", { body: { email, password } });
        if (r.step === "done") window.location.href = "/";
        else setStep(r as Step);
      } else {
        const r = await call<{ step: string }>("/api/auth/mfa", { body: { challenge: step.challenge, code } });
        if (r.step === "done") window.location.href = "/";
      }
    } catch (e) {
      setErr((e as Error).message);
      if ((e as Error).message.includes("expired")) setStep({ step: "password" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold text-brand-700">ABA Plan Assistant</h1>
          <p className="text-sm text-slate-500">Sign in. Multi-factor authentication is required.</p>
        </div>
        {expired && step.step === "password" && <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">You were signed out after 15 minutes of inactivity.</p>}
        {step.step === "password" && (
          <>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {step.step === "mfa_setup" && (
          <div className="space-y-2 text-sm">
            <p>Set up your authenticator app: scan this code, then enter the 6-digit code it shows.</p>
            {qr && <img src={qr} alt="Authenticator QR code" className="mx-auto" />}
            <p className="break-all text-center font-mono text-xs text-slate-500">{step.secret}</p>
          </div>
        )}
        {step.step !== "password" && (
          <div>
            <label className="label">Authenticator code</label>
            <input className="input text-center font-mono tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
          </div>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          {busy ? "Checking…" : step.step === "password" ? "Continue" : "Verify"}
        </button>
      </form>
    </div>
  );
}
