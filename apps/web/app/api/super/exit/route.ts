import { NextResponse } from "next/server";
import { env } from "@aba/core/env";
import { signSession } from "@aba/core/session";
import { api, sessionCookie } from "@/lib/api";

export const POST = api(
  async ({ claims }) => {
    const token = await signSession({ sub: claims.sub, tid: null, role: claims.role, lst: Math.floor(Date.now() / 1000) }, env().sessionSecret);
    return sessionCookie(NextResponse.json({ ok: true }), token);
  },
  { allowSupportWrite: true },
);
