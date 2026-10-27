import { SafeError } from "@aba/core/logger";
import { convertPlatformTemplate } from "@aba/core/svc/platform-template";
import { api } from "@/lib/api";

/** Convert an uploaded Word template (no PHI) into a draft platform standard. Nothing is saved until publish. */
export const POST = api(async ({ svc, req }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) throw new SafeError("Upload a .docx file");
  return convertPlatformTemplate(svc, Buffer.from(await file.arrayBuffer()));
});
