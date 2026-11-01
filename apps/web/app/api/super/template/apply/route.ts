import { z } from "zod";
import { applyStandardToTenant } from "@aba/core/svc/platform-template";
import { api, body } from "@/lib/api";

/** Give an existing company the current standard template (platform owner only). */
export const POST = api(async ({ svc, req }) => {
  const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(await body(req));
  return applyStandardToTenant(svc, tenantId);
});
