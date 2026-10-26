import { z } from "zod";
import { createSupportGrant } from "@aba/core/svc/admin";
import { api, body } from "@/lib/api";

export const POST = api(async ({ svc, req }) => {
  const b = z.object({ tenantId: z.string().uuid(), reason: z.string().min(5), minutes: z.number().int().min(5).max(240) }).parse(await body(req));
  return createSupportGrant(svc, b.tenantId, b.reason, b.minutes);
});
