import { NextResponse } from "next/server";
import { getPool } from "@aba/core/db";

export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
