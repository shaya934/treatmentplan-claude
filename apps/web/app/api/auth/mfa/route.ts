import { NextResponse, type NextRequest } from "next/server";
import { loginMfa } from "@aba/core/auth";
import { body, errorResponse, meta, sessionCookie } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  try {
    if (!rateLimit(`mfa:${meta(req).ip}`, 10, 300)) return NextResponse.json({ error: "Too many attempts. Wait 5 minutes." }, { status: 429 });
    const { challenge, code } = await body<{ challenge: string; code: string }>(req);
    const r = await loginMfa(String(challenge ?? ""), String(code ?? ""), meta(req));
    if (r.step !== "done") return NextResponse.json(r);
    return sessionCookie(NextResponse.json({ step: "done", user: r.user }), r.session);
  } catch (e) {
    return errorResponse(e, req);
  }
}
