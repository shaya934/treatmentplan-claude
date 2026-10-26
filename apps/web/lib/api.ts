import "server-only";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { one, withCtx } from "@aba/core/db";
import { env } from "@aba/core/env";
import { log, SafeError } from "@aba/core/logger";
import type { Principal } from "@aba/core/rbac";
import { SESSION_COOKIE, signSession, verifySession, type SessionClaims } from "@aba/core/session";
import { activeGrant } from "@aba/core/svc/admin";
import { installUsageSink, type Svc } from "@aba/core/svc/context";
import type { Role } from "@aba/core/types";
import { rateLimit } from "./ratelimit";

/**
 * Route wrapper: authenticates the session cookie, builds the principal,
 * enforces support-session read-only access and rate limits, and turns errors
 * into safe responses (never echoing input or internal messages = no PHI).
 */

installUsageSink();

export interface Ctx<P> {
  req: NextRequest;
  svc: Svc;
  params: P;
  claims: SessionClaims;
}

export function meta(req: NextRequest) {
  return { ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local", userAgent: req.headers.get("user-agent") };
}

export async function principalFrom(claims: SessionClaims): Promise<Principal & { support: boolean }> {
  const u = await withCtx({ tenantId: null, userId: claims.sub, role: "auth" }, (t) =>
    one<{ id: string; tenant_id: string | null; role: Role; credential: string | null; name: string; email: string; active: boolean }>(t, "SELECT id, tenant_id, role, credential, name, email, active FROM users WHERE id = $1", [claims.sub]),
  );
  if (!u || !u.active) throw new SafeError("Session expired", 401);
  if (u.role === "super_admin" && claims.sg) {
    const g = await activeGrant(u.id, claims.sg);
    if (!g) throw new SafeError("Support access expired", 401);
    // Support sessions see the tenant like a company admin, but read-only (enforced in api()).
    return { userId: u.id, tenantId: g.tenantId, role: "company_admin", credential: null, name: u.name, email: u.email, support: true };
  }
  return { userId: u.id, tenantId: u.tenant_id, role: u.role, credential: u.credential, name: u.name, email: u.email, support: false };
}

export async function readClaims(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token, env().sessionSecret, env().sessionIdleMinutes);
}

export function sessionCookie(res: NextResponse, token: string | null) {
  res.cookies.set(SESSION_COOKIE, token ?? "", {
    httpOnly: true,
    secure: env().mode === "aws",
    sameSite: "strict",
    path: "/",
    maxAge: token ? 12 * 3600 : 0,
  });
  return res;
}

export async function refreshCookie(res: NextResponse, claims: SessionClaims) {
  const fresh = await signSession({ ...claims, lst: Math.floor(Date.now() / 1000) }, env().sessionSecret);
  return sessionCookie(res, fresh);
}

type Handler<P, T> = (ctx: Ctx<P>) => Promise<T>;

export function api<P = Record<string, string>, T = unknown>(handler: Handler<P, T>, opts: { limit?: { key: string; max: number; windowSec: number }; allowSupportWrite?: boolean } = {}) {
  return async (req: NextRequest, route: { params: Promise<P> }) => {
    try {
      if (opts.limit && !rateLimit(`${opts.limit.key}:${meta(req).ip}`, opts.limit.max, opts.limit.windowSec)) {
        return NextResponse.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
      }
      const claims = await readClaims();
      if (!claims) return NextResponse.json({ error: "Your session has ended. Please sign in again." }, { status: 401 });
      const p = await principalFrom(claims);
      if (p.support && req.method !== "GET" && !opts.allowSupportWrite) throw new SafeError("Support sessions are read-only.", 403);
      const svc: Svc = { p, meta: meta(req) };
      const result = await handler({ req, svc, params: await route.params, claims });
      const res = result instanceof Response ? (result as unknown as NextResponse) : NextResponse.json(result ?? { ok: true });
      if (res instanceof NextResponse && !res.cookies.get(SESSION_COOKIE)) await refreshCookie(res, claims);
      return res;
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}

export function errorResponse(e: unknown, req: NextRequest) {
  if (e instanceof SafeError) return NextResponse.json({ error: e.publicMessage }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: "Some of the information sent was not valid." }, { status: 400 });
  log.error({ event: "api_error", route: new URL(req.url).pathname.replace(/[0-9a-f-]{36}/g, ":id"), method: req.method }, e);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

export async function body<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new SafeError("Invalid request body");
  }
}
