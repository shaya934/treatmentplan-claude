import { SafeError } from "@aba/core/logger";
import { uploadWordTemplate } from "@aba/core/svc/templates";
import { api } from "@/lib/api";

/** Company Word template upload (no PHI): used for export layout, or converted into a structured draft. */
export const POST = api(async ({ svc, req }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) throw new SafeError("Upload a .docx file");
  const mode = form.get("mode") === "convert" ? "convert" : "export";
  return uploadWordTemplate(svc, Buffer.from(await file.arrayBuffer()), mode);
});
