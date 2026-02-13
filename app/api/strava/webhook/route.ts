import { NextRequest, NextResponse } from "next/server";
import { qstashPublish } from "@/lib/qstash";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");
  const verifyToken = req.nextUrl.searchParams.get("hub.verify_token");

  if (mode === "subscribe" && challenge && verifyToken === process.env.STRAVA_VERIFY_TOKEN) {
    return NextResponse.json({ "hub.challenge": challenge });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const payload = await req.json();
  const base = process.env.APP_BASE_URL!;
  const queued = await qstashPublish(`${base}/api/jobs/process-strava-event`, payload);
  return NextResponse.json({ ok: true, queued });
}
