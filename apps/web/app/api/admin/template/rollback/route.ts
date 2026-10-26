import { rollbackTemplate } from "@aba/core/svc/templates";
import { api, body } from "@/lib/api";

export const POST = api(async ({ svc, req }) => {
  const b = await body<{ versionId: string; reason: string }>(req);
  return rollbackTemplate(svc, b.versionId, b.reason ?? "");
});
