import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@aba/core/session";

/**
 * Edge middleware: every page and API call needs a live session. Sessions
 * expire after SESSION_IDLE_MINUTES (default 15) without activity; API routes
 * slide the expiry forward on each authenticated request.
 */
const PUBLIC = [/^\/login/, /^\/api\/auth\/(login|mfa|new-password)/, /^\/api\/health/, /^\/api\/local-storage\//, /^\/_next\//, /^\/favicon/];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET ?? (process.env.ABA_MODE === "aws" ? "" : "local-dev-only-session-secret-change-me-0123456789");
  const idle = Number(process.env.SESSION_IDLE_MINUTES ?? 15);
  const claims = token && secret ? await verifySession(token, secret, idle) : null;
  if (!claims) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Your session has ended. Please sign in again." }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const res = NextResponse.redirect(url);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
