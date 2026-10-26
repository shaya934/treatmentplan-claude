import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePdf, SYNTHETIC_CLIENTS } from "@aba/core/fixtures";

/** Writes the synthetic client PDFs to fixtures/out so they can be uploaded through the UI. */
const out = join(import.meta.dirname, "..", "fixtures", "out");
await mkdir(out, { recursive: true });
for (const c of SYNTHETIC_CLIENTS) {
  for (const f of c.files) {
    await writeFile(join(out, f.filename), await makePdf(f));
    console.log("wrote", f.filename);
  }
}
