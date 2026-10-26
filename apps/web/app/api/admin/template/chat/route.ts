import { z } from "zod";
import { templateChat } from "@aba/core/svc/templates";
import { api, body } from "@/lib/api";

export const POST = api(async ({ svc, req }) => {
  const b = z.object({ request: z.string().min(1).max(4000), baseVersionId: z.string().uuid().optional(), baseTemplate: z.unknown().optional() }).parse(await body(req));
  return templateChat(svc, b.request, { baseVersionId: b.baseVersionId, baseTemplate: b.baseTemplate });
});
