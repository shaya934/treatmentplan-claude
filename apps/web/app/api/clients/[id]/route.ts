import { getClient, updateClient } from "@aba/core/svc/clients";
import { api, body } from "@/lib/api";

export const GET = api<{ id: string }>(async ({ svc, params }) => getClient(svc, params.id));
export const PATCH = api<{ id: string }>(async ({ svc, params, req }) => {
  const b = await body<Record<string, string>>(req);
  await updateClient(svc, params.id, { name: b.name, dob: b.dob, gender: b.gender, medicaidId: b.medicaidId, payer: b.payer, diagnosis: b.diagnosis });
  return { ok: true };
});
