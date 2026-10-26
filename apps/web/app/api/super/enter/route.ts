import { NextResponse } from "next/server";
import { env } from "@aba/core/env";
import { SafeError } from "@aba/core/logger";
import { signSession } from "@aba/core/session";
import { activeGrant, logSupportAccess } from "@aba/core/svc/admin";
import { api, body, sessionCookie } from "@/lib/api";

/** Super admin enters a tenant under an active, logged, time-limited support grant (read-only). */
export const POST = api(
  async ({ svc, req, claims }) => {
    if (claims.role !== "super_admin") throw new SafeError("Not allowed", 403);
    const { grantId } = await body<{ grantId: string }>(req);
    const g = await activeGrant(claims.sub, grantId);
    if (!g) throw new SafeError("Grant expired or not found", 403);
    await logSupportAccess(claims.sub, g.tenantId, grantId, svc.meta);
    const token = await signSession({ sub: claims.sub, tid: g.tenantId, role: "super_admin", lst: Math.floor(Date.now() / 1000), sg: grantId }, env().sessionSecret);
    return sessionCookie(NextResponse.json({ ok: true, expiresAt: g.expiresAt }), token);
  },
  { allowSupportWrite: true },
);
