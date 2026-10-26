import { z } from "zod";
import { createClient, listClients } from "@aba/core/svc/clients";
import { api, body } from "@/lib/api";

const ClientIn = z.object({
  name: z.string().min(1).max(200),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender: z.string().max(40).nullable().optional(),
  medicaidId: z.string().max(40).nullable().optional(),
  payer: z.string().max(120).nullable().optional(),
  diagnosis: z.string().max(300).nullable().optional(),
  assignedBcbaId: z.string().uuid().nullable().optional(),
});

export const GET = api(async ({ svc }) => listClients(svc));
export const POST = api(async ({ svc, req }) => {
  const b = ClientIn.parse(await body(req));
  return createClient(svc, { name: b.name, dob: b.dob ?? null, gender: b.gender ?? null, medicaidId: b.medicaidId ?? null, payer: b.payer ?? null, diagnosis: b.diagnosis ?? null, assignedBcbaId: b.assignedBcbaId ?? null });
});
