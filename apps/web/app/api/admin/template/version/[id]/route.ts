import { getTemplateVersion } from "@aba/core/svc/templates";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>(async ({ svc, params }) => getTemplateVersion(svc, params.id));
