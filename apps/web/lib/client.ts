"use client";

/** Browser fetch helper: JSON in/out, friendly errors, redirect to login on 401. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function call<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
    window.location.href = "/login?expired=1";
    throw new ApiError("Session ended", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? "Request failed", res.status);
  return data as T;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d;
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

export function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString();
}

export async function pollJob(jobId: string, onTick?: (status: string) => void): Promise<{ status: string; error: string | null; downloadUrl: string | null }> {
  for (let i = 0; i < 600; i++) {
    const j = await call<{ status: string; error: string | null; downloadUrl: string | null }>(`/api/jobs/${jobId}`);
    onTick?.(j.status);
    if (j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out");
}
