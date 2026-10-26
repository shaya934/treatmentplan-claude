import { getPlanBundle } from "@aba/core/svc/plans";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>(async ({ svc, params }) => getPlanBundle(svc, params.id));
