import { tenantUsage } from "@aba/core/svc/admin";
import { api } from "@/lib/api";

export const GET = api(async ({ svc }) => tenantUsage(svc));
