import { z } from "zod";
import { createTenant, listTenants } from "@aba/core/svc/admin";
import { api, body } from "@/lib/api";

export const GET = api(async ({ svc }) => listTenants(svc));
/** New companies start from the platform standard template (see /api/super/template). */
export const POST = api(async ({ svc, req }) => {
  const b = z.object({ name: z.string().min(2), slug: z.string(), adminEmail: z.string().email(), adminName: z.string().min(1), tempPassword: z.string().min(1) }).parse(await body(req));
  return createTenant(svc, b);
});
