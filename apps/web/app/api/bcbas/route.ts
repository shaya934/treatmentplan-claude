import { listBcbas } from "@aba/core/svc/clients";
import { api } from "@/lib/api";

export const GET = api(async ({ svc }) => listBcbas(svc));
