import { NextResponse, type NextRequest } from "next/server";
import { env } from "@aba/core/env";
import { LocalStorage, storage } from "@aba/core/storage";

/** Local mode stand-in for an S3 presigned GET. Disabled in AWS mode. */
export async function GET(req: NextRequest) {
  if (env().mode !== "local") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const key = q.get("key") ?? "";
  const st = storage() as LocalStorage;
  if (!st.verify("get", key, Number(q.get("exp")), q.get("sig") ?? "")) return NextResponse.json({ error: "Link expired" }, { status: 403 });
  const bytes = await st.get(key);
  const fn = (q.get("fn") ?? "download").replace(/[^\w.\- ]/g, "_");
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Disposition": `attachment; filename="${fn}"`, "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
}
