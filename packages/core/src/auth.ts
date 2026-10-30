import {
  AssociateSoftwareTokenCommand,
  AuthFlowType,
  ChallengeNameType,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  VerifySoftwareTokenCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminDisableUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import { audit, type RequestMeta } from "./audit";
import { one, withCtx } from "./db";
import { env } from "./env";
import { SafeError } from "./logger";
import { signChallenge, signSession, verifyChallenge } from "./session";
import type { Role } from "./types";

/**
 * Login with required MFA. Production: Amazon Cognito (password policy, TOTP
 * MFA required, groups for roles) via server-side auth flows. Local: the same
 * two-step flow against bcrypt hashes and TOTP secrets in Postgres.
 */

export type LoginStep =
  | { step: "new_password"; challenge: string }
  | { step: "mfa"; challenge: string }
  | { step: "mfa_setup"; challenge: string; otpauthUri: string; secret: string }
  | { step: "done"; session: string; user: SessionUser };

export interface SessionUser {
  id: string;
  tenantId: string | null;
  role: Role;
  name: string;
}

interface UserRow {
  id: string;
  tenant_id: string | null;
  role: Role;
  name: string;
  email: string;
  password_hash: string | null;
  totp_secret: string | null;
  active: boolean;
  cognito_sub: string | null;
}

const GENERIC = "Invalid email, password or code.";

/** Password policy (mirrors the Cognito policy in infra). */
export function checkPasswordPolicy(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return "Password needs upper and lower case letters, a number and a symbol.";
  return null;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  return withCtx({ tenantId: null, userId: null, role: "auth" }, (tx) => one<UserRow>(tx, "SELECT * FROM users WHERE lower(email) = lower($1)", [email]));
}

async function findUserBySub(sub: string): Promise<UserRow | null> {
  return withCtx({ tenantId: null, userId: null, role: "auth" }, (tx) => one<UserRow>(tx, "SELECT * FROM users WHERE cognito_sub = $1", [sub]));
}

async function logLogin(u: UserRow | null, ok: boolean, meta: RequestMeta) {
  await withCtx({ tenantId: u?.tenant_id ?? null, userId: u?.id ?? null, role: "system" }, (tx) =>
    audit(tx, { tenantId: u?.tenant_id ?? null, userId: u?.id ?? null, action: ok ? "login" : "login_failed", entity: "session" }, meta),
  );
}

async function issue(u: UserRow): Promise<LoginStep> {
  const session = await signSession({ sub: u.id, tid: u.tenant_id, role: u.role, lst: Math.floor(Date.now() / 1000) }, env().sessionSecret);
  return { step: "done", session, user: { id: u.id, tenantId: u.tenant_id, role: u.role, name: u.name } };
}

// ---------- Local mode ----------

async function localPassword(email: string, password: string, meta: RequestMeta): Promise<LoginStep> {
  const u = await findUserByEmail(email);
  const ok = !!u && u.active && !!u.password_hash && (await bcrypt.compare(password, u.password_hash));
  if (!ok) {
    await logLogin(u, false, meta);
    throw new SafeError(GENERIC, 401);
  }
  if (!u.totp_secret) {
    const secret = generateSecret();
    const challenge = await signChallenge({ uid: u.id, kind: "setup", secret }, env().sessionSecret);
    return { step: "mfa_setup", challenge, secret, otpauthUri: generateURI({ issuer: "ABA Plan Assistant", label: u.email, secret }) };
  }
  return { step: "mfa", challenge: await signChallenge({ uid: u.id, kind: "verify" }, env().sessionSecret) };
}

async function localMfa(challenge: string, code: string, meta: RequestMeta): Promise<LoginStep> {
  const c = await verifyChallenge(challenge, env().sessionSecret);
  if (!c) throw new SafeError("Your sign-in expired. Start again.", 401);
  const u = await withCtx({ tenantId: null, userId: null, role: "auth" }, (tx) => one<UserRow>(tx, "SELECT * FROM users WHERE id = $1", [c.uid]));
  if (!u || !u.active) throw new SafeError(GENERIC, 401);
  const secret = c.kind === "setup" ? c.secret! : u.totp_secret!;
  const res = await verifyTotp({ secret, token: code.replace(/\s/g, "") });
  if (!res.valid) {
    await logLogin(u, false, meta);
    throw new SafeError(GENERIC, 401);
  }
  if (c.kind === "setup") {
    await withCtx({ tenantId: u.tenant_id, userId: u.id, role: "mfa_enroll" }, async (tx) => {
      const r = await tx.query("UPDATE users SET totp_secret = $1 WHERE id = $2", [secret, u.id]);
      if (r.rowCount !== 1) throw new SafeError(GENERIC, 401);
      await audit(tx, { tenantId: u.tenant_id, userId: u.id, action: "mfa_setup", entity: "user", entityId: u.id }, meta);
    });
  }
  await logLogin(u, true, meta);
  return issue(u);
}

// ---------- Cognito ----------

let cognito: CognitoIdentityProviderClient | null = null;
const idp = () => (cognito ??= new CognitoIdentityProviderClient({ region: env().region }));
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
const jwtVerifier = () => (verifier ??= CognitoJwtVerifier.create({ userPoolId: env().cognitoUserPoolId, tokenUse: "id", clientId: env().cognitoClientId }));

async function finishCognito(idToken: string, meta: RequestMeta): Promise<LoginStep> {
  const payload = await jwtVerifier().verify(idToken);
  const u = await findUserBySub(payload.sub);
  if (!u || !u.active) throw new SafeError(GENERIC, 401);
  await logLogin(u, true, meta);
  return issue(u);
}

/** Map the challenge Cognito returns after a password (or new password) to the next login step. */
async function cognitoChallenge(r: { ChallengeName?: string; Session?: string }, email: string): Promise<LoginStep> {
  if (r.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED) {
    // First sign-in with the temporary password Cognito emailed.
    return { step: "new_password", challenge: await signChallenge({ kind: "cognito_new_password", s: r.Session!, email }, env().sessionSecret) };
  }
  if (r.ChallengeName === ChallengeNameType.SOFTWARE_TOKEN_MFA) {
    return { step: "mfa", challenge: await signChallenge({ kind: "cognito_verify", s: r.Session!, email }, env().sessionSecret) };
  }
  if (r.ChallengeName === ChallengeNameType.MFA_SETUP) {
    const assoc = await idp().send(new AssociateSoftwareTokenCommand({ Session: r.Session! }));
    const secret = assoc.SecretCode!;
    return {
      step: "mfa_setup",
      secret,
      otpauthUri: generateURI({ issuer: "ABA Plan Assistant", label: email, secret }),
      challenge: await signChallenge({ kind: "cognito_setup", s: assoc.Session!, email }, env().sessionSecret),
    };
  }
  throw new SafeError("MFA is required for every account.", 401);
}

async function cognitoPassword(email: string, password: string, meta: RequestMeta): Promise<LoginStep> {
  try {
    const r = await idp().send(new InitiateAuthCommand({ AuthFlow: AuthFlowType.USER_PASSWORD_AUTH, ClientId: env().cognitoClientId, AuthParameters: { USERNAME: email, PASSWORD: password } }));
    return await cognitoChallenge(r, email);
  } catch (e) {
    if (e instanceof SafeError) throw e;
    await logLogin(await findUserByEmail(email), false, meta);
    throw new SafeError(GENERIC, 401);
  }
}

async function cognitoNewPassword(challenge: string, newPassword: string, meta: RequestMeta): Promise<LoginStep> {
  const c = await verifyChallenge(challenge, env().sessionSecret);
  if (!c || c.kind !== "cognito_new_password") throw new SafeError("Your sign-in expired. Start again.", 401);
  const policy = checkPasswordPolicy(newPassword);
  if (policy) throw new SafeError(policy, 400);
  try {
    const r = await idp().send(
      new RespondToAuthChallengeCommand({ ClientId: env().cognitoClientId, ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED, Session: c.s, ChallengeResponses: { USERNAME: c.email!, NEW_PASSWORD: newPassword } }),
    );
    return await cognitoChallenge(r, c.email!);
  } catch (e) {
    if (e instanceof SafeError) throw e;
    await logLogin(await findUserByEmail(c.email ?? ""), false, meta);
    throw new SafeError("That password could not be set. Start again.", 401);
  }
}

async function cognitoMfa(challenge: string, code: string, meta: RequestMeta): Promise<LoginStep> {
  const c = await verifyChallenge(challenge, env().sessionSecret);
  if (!c) throw new SafeError("Your sign-in expired. Start again.", 401);
  try {
    if (c.kind === "cognito_setup") {
      const v = await idp().send(new VerifySoftwareTokenCommand({ Session: c.s, UserCode: code }));
      const r = await idp().send(new RespondToAuthChallengeCommand({ ClientId: env().cognitoClientId, ChallengeName: ChallengeNameType.MFA_SETUP, Session: v.Session, ChallengeResponses: { USERNAME: c.email! } }));
      return finishCognito(r.AuthenticationResult!.IdToken!, meta);
    }
    const r = await idp().send(new RespondToAuthChallengeCommand({ ClientId: env().cognitoClientId, ChallengeName: ChallengeNameType.SOFTWARE_TOKEN_MFA, Session: c.s, ChallengeResponses: { USERNAME: c.email!, SOFTWARE_TOKEN_MFA_CODE: code } }));
    return finishCognito(r.AuthenticationResult!.IdToken!, meta);
  } catch (e) {
    if (e instanceof SafeError) throw e;
    await logLogin(await findUserByEmail(c.email ?? ""), false, meta);
    throw new SafeError(GENERIC, 401);
  }
}

export async function loginPassword(email: string, password: string, meta: RequestMeta): Promise<LoginStep> {
  return env().mode === "aws" ? cognitoPassword(email, password, meta) : localPassword(email, password, meta);
}

export async function loginMfa(challenge: string, code: string, meta: RequestMeta): Promise<LoginStep> {
  return env().mode === "aws" ? cognitoMfa(challenge, code, meta) : localMfa(challenge, code, meta);
}

/** Set a permanent password on first sign-in (Cognito only; local seed users have permanent passwords). */
export async function loginNewPassword(challenge: string, newPassword: string, meta: RequestMeta): Promise<LoginStep> {
  if (env().mode !== "aws") throw new SafeError("Your sign-in expired. Start again.", 401);
  return cognitoNewPassword(challenge, newPassword, meta);
}

/** Create the identity for a new user. Returns the cognito sub (aws) or a password hash (local). */
export async function provisionIdentity(email: string, role: Role, tempPassword: string): Promise<{ cognitoSub: string | null; passwordHash: string | null }> {
  if (env().mode === "aws") {
    const r = await idp().send(
      new AdminCreateUserCommand({ UserPoolId: env().cognitoUserPoolId, Username: email, UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }], DesiredDeliveryMediums: ["EMAIL"] }),
    );
    await idp().send(new AdminAddUserToGroupCommand({ UserPoolId: env().cognitoUserPoolId, Username: email, GroupName: role }));
    const sub = r.User?.Attributes?.find((a) => a.Name === "sub")?.Value ?? null;
    return { cognitoSub: sub, passwordHash: null };
  }
  const policy = checkPasswordPolicy(tempPassword);
  if (policy) throw new SafeError(policy);
  return { cognitoSub: null, passwordHash: await bcrypt.hash(tempPassword, 12) };
}

export async function disableIdentity(email: string) {
  if (env().mode === "aws") await idp().send(new AdminDisableUserCommand({ UserPoolId: env().cognitoUserPoolId, Username: email }));
}
