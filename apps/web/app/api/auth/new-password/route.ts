import { NextResponse, type NextRequest } from "next/server";
import { loginNewPassword } from "@aba/core/auth";
import { body, errorResponse, meta, sessionCookie } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  try {
    if (!rateLimit(`newpw:${meta(req).ip}`, 10, 300)) return NextResponse.json({ error: "Too many attempts. Wait 5 minutes." }, { status: 429 });
    const { challenge, password } = await body<{ challenge: string; password: string }>(req);
    const r = await loginNewPassword(String(challenge ?? ""), String(password ?? ""), meta(req));
    if (r.step === "done") return sessionCookie(NextResponse.json({ step: "done", user: r.user }), r.session);
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e, req);
  }
}
