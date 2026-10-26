import { publishTemplate } from "@aba/core/svc/templates";
import { parseTemplate } from "@aba/core/template/schema";
import { api, body } from "@/lib/api";

export const POST = api(async ({ svc, req }) => {
  const b = await body<{ template: unknown; changeReason: string; complianceReason?: string; warnings?: Array<{ message: string }> }>(req);
  return publishTemplate(svc, { template: parseTemplate(b.template), changeReason: b.changeReason, complianceReason: b.complianceReason, warnings: b.warnings });
});
