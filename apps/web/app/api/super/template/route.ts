import { z } from "zod";
import { getPlatformTemplate, publishPlatformTemplate } from "@aba/core/svc/platform-template";
import { api, body } from "@/lib/api";

/** Platform standard template (platform owner): GET the current standard, POST to publish a new one. */
export const GET = api(async ({ svc }) => getPlatformTemplate(svc));
export const POST = api(async ({ svc, req }) => {
  const b = z.union([z.object({ builtIn: z.literal(true), changeReason: z.string() }), z.object({ template: z.unknown(), changeReason: z.string() })]).parse(await body(req));
  return publishPlatformTemplate(svc, b as never);
});
