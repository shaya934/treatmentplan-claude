import { getCurrentTemplate, templateMessages } from "@aba/core/svc/templates";
import { api } from "@/lib/api";

export const GET = api(async ({ svc }) => {
  const cur = await getCurrentTemplate(svc);
  const messages = svc.p.role === "company_admin" ? await templateMessages(svc) : [];
  return { ...cur, messages };
});
