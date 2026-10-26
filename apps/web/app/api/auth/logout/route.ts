import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@aba/core/audit";
import { withCtx } from "@aba/core/db";
import { meta, readClaims, sessionCookie } from "@/lib/api";

export async function POST(req: NextRequest) {
  const c = await readClaims();
  if (c) await withCtx({ tenantId: c.tid, userId: c.sub, role: "system" }, (t) => audit(t, { tenantId: c.tid, userId: c.sub, action: "logout", entity: "session" }, meta(req))).catch(() => {});
  return sessionCookie(NextResponse.json({ ok: true }), null);
}
