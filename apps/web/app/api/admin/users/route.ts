import { z } from "zod";
import { createUser, listUsers } from "@aba/core/svc/admin";
import { api, body } from "@/lib/api";

export const GET = api(async ({ svc }) => listUsers(svc));
export const POST = api(async ({ svc, req }) => {
  const b = z
    .object({ email: z.string().email(), name: z.string().min(1), role: z.enum(["company_admin", "clinical_director", "bcba", "read_only"]), credential: z.string().optional(), npi: z.string().optional(), tempPassword: z.string().min(1) })
    .parse(await body(req));
  return createUser(svc, b);
});
