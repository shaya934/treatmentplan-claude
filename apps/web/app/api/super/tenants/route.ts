import { z } from "zod";
import { createTenant, listTenants } from "@aba/core/svc/admin";
import { WE_ACHIEVE_TEMPLATE } from "@aba/core/template/we-achieve-template";
import { api, body } from "@/lib/api";

export const GET = api(async ({ svc }) => listTenants(svc));
export const POST = api(async ({ svc, req }) => {
  const b = z.object({ name: z.string().min(2), slug: z.string(), adminEmail: z.string().email(), adminName: z.string().min(1), tempPassword: z.string().min(1) }).parse(await body(req));
  return createTenant(svc, { ...b, template: WE_ACHIEVE_TEMPLATE });
});
