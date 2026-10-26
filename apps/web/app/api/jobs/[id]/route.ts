import { getJob } from "@aba/core/svc/work";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>(async ({ svc, params }) => getJob(svc, params.id));
