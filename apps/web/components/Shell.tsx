"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { call } from "@/lib/client";
import { MeContext, type Me } from "./useMe";

const ROLE_LABEL: Record<string, string> = { super_admin: "Platform owner", company_admin: "Company admin", clinical_director: "Clinical director", bcba: "BCBA", read_only: "Read-only" };

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [warn, setWarn] = useState(false);
  const last = useRef(Date.now());
  const path = usePathname();

  useEffect(() => {
    call<Me>("/api/auth/me").then(setMe).catch(() => {});
  }, []);

  const logout = useCallback(async (expired = false) => {
    await call("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = expired ? "/login?expired=1" : "/login";
  }, []);

  // Automatic logoff after the idle limit (15 minutes by default), with a 1-minute warning.
  useEffect(() => {
    if (!me) return;
    const bump = () => {
      last.current = Date.now();
      setWarn(false);
    };
    const evs = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    let lastPing = Date.now();
    const t = setInterval(() => {
      const idle = (Date.now() - last.current) / 60000;
      if (idle >= me.idleMinutes) logout(true);
      else if (idle >= me.idleMinutes - 1) setWarn(true);
      // keep the server session alive while the user is active
      if (idle < 1 && Date.now() - lastPing > 4 * 60000) {
        lastPing = Date.now();
        call("/api/auth/me").catch(() => {});
      }
    }, 5000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, [me, logout]);

  if (!me) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  const nav: Array<[string, string, boolean]> = [
    ["/", "Dashboard", me.user.role !== "super_admin" || !!me.user.tenantId],
    ["/clients", "Clients", me.user.role !== "super_admin" || !!me.user.tenantId],
    ["/admin/template", "Template", !!me.can["template.edit"]],
    ["/admin/users", "Users", !!me.can["user.manage"]],
    ["/admin/audit", "Audit log", !!me.can["audit.view"]],
    ["/admin/usage", "Usage", !!me.can["usage.view"]],
    ["/super", "Platform", me.user.role === "super_admin" && !me.user.support],
  ];
  return (
    <MeContext.Provider value={me}>
      <div className="min-h-screen bg-slate-50">
        {me.user.support && (
          <div className="bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-white">
            Support session (read-only, logged).{" "}
            <button className="underline" onClick={() => call("/api/super/exit", { method: "POST" }).then(() => (window.location.href = "/super"))}>
              Exit
            </button>
          </div>
        )}
        {me.mode === "local" && <div className="bg-slate-800 px-4 py-1 text-center text-[11px] text-slate-200">Local development mode: synthetic data only, mock AI (no Bedrock)</div>}
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-[1500px] items-center gap-6 px-4 py-2.5">
            <Link href="/" className="font-semibold text-brand-700">
              ABA Plan Assistant
            </Link>
            <nav className="flex gap-1 text-sm">
              {nav
                .filter(([, , show]) => show)
                .map(([href, label]) => (
                  <Link key={href} href={href} className={`rounded px-2.5 py-1 ${(href === "/" ? path === "/" : path.startsWith(href)) ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"}`}>
                    {label}
                  </Link>
                ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-slate-600">
                {me.user.name} <span className="badge bg-slate-100 text-slate-600">{ROLE_LABEL[me.user.role]}</span>
              </span>
              <button className="btn btn-sm" onClick={() => logout()}>
                Sign out
              </button>
            </div>
          </div>
        </header>
        {warn && <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">You will be signed out in about a minute because of inactivity. Move the mouse or press a key to stay signed in.</div>}
        <main className="mx-auto max-w-[1500px] px-4 py-5">{children}</main>
      </div>
    </MeContext.Provider>
  );
}
