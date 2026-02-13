import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { buildStravaAuthorizeUrl } from "@/lib/strava";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state");
  if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });

  const rows = await sql`SELECT state FROM oauth_states WHERE state = ${state} LIMIT 1`;
  if (rows.length === 0) return NextResponse.json({ error: "Invalid state" }, { status: 400 });

  return NextResponse.redirect(buildStravaAuthorizeUrl(state));
}
