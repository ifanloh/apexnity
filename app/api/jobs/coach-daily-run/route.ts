import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const baseUrl = process.env.APP_BASE_URL;
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!baseUrl || !secret) return NextResponse.json({ ok: false, error: "Missing APP_BASE_URL/INTERNAL_JOB_SECRET" }, { status: 500 });

  const res = await fetch(`${baseUrl}/api/jobs/coach-daily`, {
    method: "POST",
    headers: { "x-internal-job-secret": secret },
  });

  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "Content-Type": "application/json" } });
}
