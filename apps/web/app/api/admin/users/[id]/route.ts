import { z } from "zod";
import { updateUser } from "@aba/core/svc/admin";
import { api, body } from "@/lib/api";

export const PATCH = api<{ id: string }>(async ({ svc, params, req }) => {
  const b = z.object({ role: z.enum(["company_admin", "clinical_director", "bcba", "read_only"]).optional(), active: z.boolean().optional(), name: z.string().optional(), credential: z.string().optional(), npi: z.string().optional() }).parse(await body(req));
  await updateUser(svc, params.id, b);
  return { ok: true };
});
