import { downloadUrl } from "@aba/core/svc/files";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>(async ({ svc, params }) => ({ url: await downloadUrl(svc, params.id) }));
