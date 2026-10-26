import { describe, expect, it } from "vitest";
import { rateLimit } from "../lib/ratelimit";

describe("login/upload rate limiting", () => {
  it("blocks after the limit within the window and recovers after it", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(rateLimit("login:1.2.3.4", 10, 300, t0 + i)).toBe(true);
    expect(rateLimit("login:1.2.3.4", 10, 300, t0 + 20)).toBe(false);
    expect(rateLimit("login:5.6.7.8", 10, 300, t0 + 20)).toBe(true);
    expect(rateLimit("login:1.2.3.4", 10, 300, t0 + 301_000)).toBe(true);
  });
});
