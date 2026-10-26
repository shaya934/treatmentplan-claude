/**
 * In-process sliding-window rate limiter for login and upload endpoints.
 * Production also has AWS WAF rate-based rules on the load balancer (infra).
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowSec: number, now = Date.now()): boolean {
  const since = now - windowSec * 1000;
  const list = (hits.get(key) ?? []).filter((t) => t > since);
  if (list.length >= max) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => t > since)) hits.delete(k);
  }
  return true;
}
