import { z } from "zod";
import { createPlan } from "@aba/core/svc/plans";
import { api, body } from "@/lib/api";

const In = z.object({
  clientId: z.string().uuid(),
  type: z.enum(["initial", "reassessment"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  templateVersionId: z.string().uuid().optional(),
});

export const POST = api(async ({ svc, req }) => createPlan(svc, In.parse(await body(req))));
