import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.INTERNAL_JOB_SECRET || secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const verifyToken = process.env.STRAVA_VERIFY_TOKEN;
  const baseUrl = process.env.APP_BASE_URL;

  if (!clientId || !clientSecret || !verifyToken || !baseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing env. Need STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_VERIFY_TOKEN, APP_BASE_URL",
      },
      { status: 500 }
    );
  }

  const callbackUrl = `${baseUrl}/api/strava/webhook`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    callback_url: callbackUrl,
    verify_token: verifyToken,
  });

  const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
