import { NextResponse, type NextRequest } from "next/server";
import { env } from "@aba/core/env";
import { LocalStorage, MAX_UPLOAD_BYTES, storage } from "@aba/core/storage";

/** Local mode stand-in for an S3 presigned PUT. Disabled in AWS mode. */
export async function PUT(req: NextRequest) {
  if (env().mode !== "local") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const key = q.get("key") ?? "";
  const x = q.get("x") ?? "";
  const st = storage() as LocalStorage;
  if (!st.verify("put", key, Number(q.get("exp")), q.get("sig") ?? "", x)) return NextResponse.json({ error: "Link expired" }, { status: 403 });
  const [mime, size] = x.split("|");
  if (req.headers.get("content-type") !== mime) return NextResponse.json({ error: "Bad content type" }, { status: 400 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length !== Number(size) || buf.length > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Bad size" }, { status: 400 });
  await st.put(key, buf);
  return new NextResponse(null, { status: 200 });
}
