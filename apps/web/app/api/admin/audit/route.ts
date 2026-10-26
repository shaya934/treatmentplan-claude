import { searchAudit } from "@aba/core/svc/admin";
import { api } from "@/lib/api";

export const GET = api(async ({ svc, req }) => {
  const q = req.nextUrl.searchParams;
  return searchAudit(svc, { userId: q.get("userId") || undefined, action: q.get("action") || undefined, entity: q.get("entity") || undefined, entityId: q.get("entityId") || undefined, from: q.get("from") || undefined, to: q.get("to") || undefined });
});
