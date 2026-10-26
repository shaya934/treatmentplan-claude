import { reassignClient } from "@aba/core/svc/clients";
import { api, body } from "@/lib/api";

export const POST = api<{ id: string }>(async ({ svc, params, req }) => {
  const { bcbaId } = await body<{ bcbaId: string }>(req);
  await reassignClient(svc, params.id, bcbaId);
  return { ok: true };
});
