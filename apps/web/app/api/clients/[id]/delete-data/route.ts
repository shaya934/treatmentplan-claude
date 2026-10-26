import { deleteClientData } from "@aba/core/svc/admin";
import { api, body } from "@/lib/api";
import { SafeError } from "@aba/core/logger";

export const POST = api<{ id: string }>(async ({ svc, params, req }) => {
  const { confirm } = await body<{ confirm: string }>(req);
  if (confirm !== "DELETE") throw new SafeError('Type DELETE to confirm.');
  await deleteClientData(svc, params.id);
  return { ok: true };
});
