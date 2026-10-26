import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "../src/session";
import { checkPasswordPolicy } from "../src/auth";

const secret = "test-secret-0123456789-0123456789-0123456789";

describe("sessions", () => {
  it("expire after 15 minutes idle and slide with activity", async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = await signSession({ sub: "u", tid: "t", role: "bcba", lst: now - 14 * 60 }, secret);
    expect(await verifySession(t, secret, 15, now)).not.toBeNull();
    expect(await verifySession(t, secret, 15, now + 61)).toBeNull();
    const fresh = await signSession({ sub: "u", tid: "t", role: "bcba", lst: now }, secret);
    expect(await verifySession(fresh, secret, 15, now + 14 * 60)).not.toBeNull();
  });
  it("rejects tampered or foreign tokens", async () => {
    const t = await signSession({ sub: "u", tid: "t", role: "bcba", lst: Math.floor(Date.now() / 1000) }, secret);
    expect(await verifySession(t, secret + "x", 15)).toBeNull();
    const [h, p, sig] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), role: "company_admin" })).toString("base64url")}.${sig}`;
    expect(await verifySession(forged, secret, 15)).toBeNull();
  });
  it("password policy matches Cognito (12+, mixed case, digit, symbol)", () => {
    expect(checkPasswordPolicy("short")).not.toBeNull();
    expect(checkPasswordPolicy("alllowercase123!")).not.toBeNull();
    expect(checkPasswordPolicy("Good-Passw0rd!")).toBeNull();
  });
});
