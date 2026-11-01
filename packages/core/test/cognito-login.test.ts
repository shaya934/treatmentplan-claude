import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { loginMfa, loginNewPassword, loginPassword } from "../src/auth";
import { resetEnvCache } from "../src/env";

/** First sign-in in AWS mode: temporary password -> new password -> MFA setup. Cognito is stubbed; no AWS or database. */
const meta = { ip: "127.0.0.1", userAgent: "vitest" } as never;
const AWS_ENV = {
  ABA_MODE: "aws",
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  SESSION_SECRET: "test-session-secret-0123456789-abcdefghijklmnop",
  FILES_BUCKET: "test-bucket",
  JOBS_QUEUE_URL: "https://sqs.us-east-2.amazonaws.com/111111111111/test",
  COGNITO_USER_POOL_ID: "us-east-2_test",
  COGNITO_CLIENT_ID: "test-client",
};
const saved: Record<string, string | undefined> = {};
const sent: { name: string; input: Record<string, unknown> }[] = [];

beforeAll(() => {
  for (const [k, v] of Object.entries(AWS_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  resetEnvCache();
  vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation((async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    sent.push({ name: cmd.constructor.name, input: cmd.input });
    switch (cmd.constructor.name) {
      case "InitiateAuthCommand":
        return { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s-initial" };
      case "RespondToAuthChallengeCommand":
        return { ChallengeName: "MFA_SETUP", Session: "s-after-new-password" };
      case "AssociateSoftwareTokenCommand":
        return { SecretCode: "JBSWY3DPEHPK3PXP", Session: "s-associate" };
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }) as never);
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

beforeEach(() => {
  sent.length = 0;
});

describe("Cognito first sign-in", () => {
  it("asks for a new password when Cognito returns NEW_PASSWORD_REQUIRED", async () => {
    const r = await loginPassword("owner@example.com", "Temp-Passw0rd!", meta);
    expect(r.step).toBe("new_password");
  });

  it("rejects a new password that breaks the policy without calling Cognito", async () => {
    const r = await loginPassword("owner@example.com", "Temp-Passw0rd!", meta);
    sent.length = 0;
    await expect(loginNewPassword((r as { challenge: string }).challenge, "short", meta)).rejects.toThrow(/12 characters/);
    expect(sent).toHaveLength(0);
  });

  it("sets the new password and continues to MFA setup", async () => {
    const r = await loginPassword("owner@example.com", "Temp-Passw0rd!", meta);
    sent.length = 0;
    const next = await loginNewPassword((r as { challenge: string }).challenge, "Good-New-Passw0rd!", meta);
    expect(next.step).toBe("mfa_setup");
    expect(next).toMatchObject({ secret: "JBSWY3DPEHPK3PXP" });
    expect(sent[0]).toMatchObject({
      name: "RespondToAuthChallengeCommand",
      input: { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s-initial", ChallengeResponses: { USERNAME: "owner@example.com", NEW_PASSWORD: "Good-New-Passw0rd!" } },
    });
    expect(sent[1]).toMatchObject({ name: "AssociateSoftwareTokenCommand", input: { Session: "s-after-new-password" } });
  });

  it("does not accept another step's challenge as a new-password challenge", async () => {
    const r = await loginPassword("owner@example.com", "Temp-Passw0rd!", meta);
    const setup = await loginNewPassword((r as { challenge: string }).challenge, "Good-New-Passw0rd!", meta);
    await expect(loginNewPassword((setup as { challenge: string }).challenge, "Good-New-Passw0rd!", meta)).rejects.toThrow(/expired/);
    await expect(loginMfa("not-a-token", "123456", meta)).rejects.toThrow(/expired/);
  });
});
