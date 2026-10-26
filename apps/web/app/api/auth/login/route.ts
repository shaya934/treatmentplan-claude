import { NextResponse, type NextRequest } from "next/server";
import { loginPassword } from "@aba/core/auth";
import { body, errorResponse, meta, sessionCookie } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  try {
    if (!rateLimit(`login:${meta(req).ip}`, 10, 300)) return NextResponse.json({ error: "Too many attempts. Wait 5 minutes." }, { status: 429 });
    const { email, password } = await body<{ email: string; password: string }>(req);
    const r = await loginPassword(String(email ?? ""), String(password ?? ""), meta(req));
    if (r.step === "done") return sessionCookie(NextResponse.json({ step: "done", user: r.user }), r.session);
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e, req);
  }
}
