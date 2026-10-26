import { jwtVerify, SignJWT } from "jose";
import type { Role } from "./types";

/**
 * Session tokens (HttpOnly cookie). Edge-safe (jose only) so Next middleware
 * can enforce the 15-minute idle timeout on every request. "lst" (last seen)
 * slides forward on activity; a token idle longer than the limit is rejected.
 */
export interface SessionClaims {
  sub: string; // user id
  tid: string | null; // tenant id (super admin: support-grant tenant or null)
  role: Role;
  lst: number; // last activity, epoch seconds
  sg?: string; // support grant id when a super admin is inside a tenant
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(c: SessionClaims, secret: string, maxHours = 12): Promise<string> {
  return new SignJWT({ tid: c.tid, role: c.role, lst: c.lst, sg: c.sg })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(`${maxHours}h`)
    .setAudience("aba-session")
    .sign(key(secret));
}

export async function verifySession(token: string, secret: string, idleMinutes: number, now = Math.floor(Date.now() / 1000)): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { audience: "aba-session" });
    const c: SessionClaims = { sub: payload.sub!, tid: (payload.tid as string | null) ?? null, role: payload.role as Role, lst: payload.lst as number, sg: payload.sg as string | undefined };
    if (now - c.lst > idleMinutes * 60) return null;
    return c;
  } catch {
    return null;
  }
}

/** Short-lived token between the password step and the MFA step. */
export async function signChallenge(data: Record<string, string>, secret: string): Promise<string> {
  return new SignJWT(data).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").setAudience("aba-mfa").sign(key(secret));
}

export async function verifyChallenge(token: string, secret: string): Promise<Record<string, string> | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { audience: "aba-mfa" });
    return payload as Record<string, string>;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "aba_session";
