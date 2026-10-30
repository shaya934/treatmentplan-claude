import type { IncomingMessage } from "node:http";
import {
  AssociateSoftwareTokenCommand,
  AuthFlowType,
  ChallengeNameType,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { jwtVerify, SignJWT } from "jose";
import QRCode from "qrcode";
import { audit, cfg, HttpError } from "./config";

/**
 * Sign-in with Amazon Cognito: email + password, then an authenticator-app code
 * (MFA is required on the user pool). First sign-in sets a new password and
 * links the authenticator app. The server never stores passwords.
 *
 * The browser then holds an HttpOnly session cookie that expires after 15 minutes
 * without activity and after 12 hours at most.
 */

const COOKIE = "drop_session";
const IDLE_MIN = 15;
const MAX_HOURS = 12;
const GENERIC = "Invalid email, password or code.";
const EXPIRED = "Your sign-in expired. Start again.";

export interface User {
  sub: string;
  email: string;
  /** Sign-in time, epoch seconds (the 12-hour cap). */
  iat: number;
}

type Reply = [body: Record<string, unknown>, headers: Record<string, string>];

const key = () => new TextEncoder().encode(cfg.sessionSecret || "local-development-only-secret-xxxxxxxx");
const idp = new CognitoIdentityProviderClient({ region: cfg.region });
const verifier = cfg.devNoAuth ? null : CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, tokenUse: "id", clientId: cfg.clientId });

const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.secureCookie ? "; Secure" : ""}`;

async function sessionCookie(u: User): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + IDLE_MIN * 60, u.iat + MAX_HOURS * 3600);
  const jwt = await new SignJWT({ email: u.email }).setProtectedHeader({ alg: "HS256" }).setSubject(u.sub).setIssuedAt(u.iat).setExpirationTime(exp).setAudience("drop-session").sign(key());
  return cookie(jwt, exp - now);
}

export async function readSession(req: IncomingMessage): Promise<User | null> {
  if (cfg.devNoAuth) return { sub: "local-dev", email: "local@dev", iat: Math.floor(Date.now() / 1000) };
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, key(), { audience: "drop-session" });
    return { sub: payload.sub!, email: String(payload.email), iat: payload.iat! };
  } catch {
    return null; // idle too long, past 12 hours, or tampered with
  }
}

export const refreshSession = sessionCookie;
export const logout = () => cookie("", 0);

/** Short-lived token carrying Cognito's session between sign-in steps. */
async function challenge(data: Record<string, string>) {
  return new SignJWT(data).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").setAudience("drop-mfa").sign(key());
}
async function readChallenge(token: string): Promise<Record<string, string>> {
  try {
    return (await jwtVerify(token, key(), { audience: "drop-mfa" })).payload as Record<string, string>;
  } catch {
    throw new HttpError(401, EXPIRED);
  }
}

async function next(r: { ChallengeName?: string; Session?: string }, email: string): Promise<Reply> {
  if (r.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED) {
    return [{ step: "new_password", challenge: await challenge({ kind: "new_password", s: r.Session!, email }) }, {}];
  }
  if (r.ChallengeName === ChallengeNameType.SOFTWARE_TOKEN_MFA) {
    return [{ step: "mfa", challenge: await challenge({ kind: "verify", s: r.Session!, email }) }, {}];
  }
  if (r.ChallengeName === ChallengeNameType.MFA_SETUP) {
    const assoc = await idp.send(new AssociateSoftwareTokenCommand({ Session: r.Session! }));
    const secret = assoc.SecretCode!;
    const uri = `otpauth://totp/${encodeURIComponent(`We Achieve Plans:${email}`)}?secret=${secret}&issuer=${encodeURIComponent("We Achieve Plans")}`;
    return [{ step: "mfa_setup", secret, qr: await QRCode.toDataURL(uri), challenge: await challenge({ kind: "setup", s: assoc.Session!, email }) }, {}];
  }
  throw new HttpError(401, "An authenticator code is required for every account.");
}

async function done(idToken: string, ip: string): Promise<Reply> {
  const p = await verifier!.verify(idToken);
  const u: User = { sub: p.sub, email: String(p.email ?? ""), iat: Math.floor(Date.now() / 1000) };
  audit("login", u.email, { ip });
  return [{ step: "done", email: u.email }, { "set-cookie": await sessionCookie(u) }];
}

function fail(email: string, ip: string, e: unknown, message = GENERIC): never {
  if (e instanceof HttpError) throw e;
  audit("login_failed", email.slice(0, 200), { ip, errorName: (e as Error).name });
  throw new HttpError(401, message);
}

export async function login(email: string, password: string, ip: string): Promise<Reply> {
  const e = email.trim().toLowerCase();
  try {
    const r = await idp.send(new InitiateAuthCommand({ AuthFlow: AuthFlowType.USER_PASSWORD_AUTH, ClientId: cfg.clientId, AuthParameters: { USERNAME: e, PASSWORD: password } }));
    if (r.AuthenticationResult?.IdToken) throw new HttpError(401, "An authenticator code is required for every account.");
    return await next(r, e);
  } catch (err) {
    fail(e, ip, err);
  }
}

export async function newPassword(token: string, password: string, ip: string): Promise<Reply> {
  const c = await readChallenge(token);
  if (c.kind !== "new_password") throw new HttpError(401, EXPIRED);
  if (password.length < 14) throw new HttpError(400, "Use at least 14 characters.");
  try {
    const r = await idp.send(
      new RespondToAuthChallengeCommand({ ClientId: cfg.clientId, ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED, Session: c.s, ChallengeResponses: { USERNAME: c.email!, NEW_PASSWORD: password } }),
    );
    return await next(r, c.email!);
  } catch (err) {
    fail(c.email!, ip, err, "That password could not be set. It needs upper and lower case letters, a number and a symbol.");
  }
}

export async function mfa(token: string, code: string, ip: string): Promise<Reply> {
  const c = await readChallenge(token);
  const userCode = code.replace(/\s/g, "");
  try {
    if (c.kind === "setup") {
      const v = await idp.send(new VerifySoftwareTokenCommand({ Session: c.s, UserCode: userCode, FriendlyDeviceName: "Authenticator" }));
      const r = await idp.send(new RespondToAuthChallengeCommand({ ClientId: cfg.clientId, ChallengeName: ChallengeNameType.MFA_SETUP, Session: v.Session, ChallengeResponses: { USERNAME: c.email! } }));
      return await done(r.AuthenticationResult!.IdToken!, ip);
    }
    if (c.kind !== "verify") throw new HttpError(401, EXPIRED);
    const r = await idp.send(
      new RespondToAuthChallengeCommand({ ClientId: cfg.clientId, ChallengeName: ChallengeNameType.SOFTWARE_TOKEN_MFA, Session: c.s, ChallengeResponses: { USERNAME: c.email!, SOFTWARE_TOKEN_MFA_CODE: userCode } }),
    );
    return await done(r.AuthenticationResult!.IdToken!, ip);
  } catch (err) {
    fail(c.email!, ip, err);
  }
}
