import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

async function refreshIfNeeded(athleteId: number) {
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at
    FROM strava_accounts
    WHERE athlete_id = ${athleteId}
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error("Strava account not found");

  const acc = rows[0] as any;
  const now = Math.floor(Date.now() / 1000);

  if (acc.expires_at > now + 60) return acc.access_token as string;

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: acc.refresh_token,
  });

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error(`Strava refresh failed: ${res.status} ${await res.text()}`);
  const j = await res.json();

  await sql`
    UPDATE strava_accounts
    SET access_token = ${j.access_token},
        refresh_token = ${j.refresh_token},
        expires_at = ${j.expires_at},
        updated_at = NOW()
    WHERE athlete_id = ${athleteId}
  `;

  return j.access_token as string;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-job-secret");
  if (!process.env.INTERNAL_JOB_SECRET || secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { telegramUserId, days } = await req.json();
  const nDays = Math.max(1, Math.min(30, Number(days || 7))); // batasi 1..30 hari

  const accRows = await sql`
    SELECT athlete_id
    FROM strava_accounts
    WHERE telegram_user_id = ${telegramUserId}
    LIMIT 1
  `;
  if (accRows.length === 0) {
    return NextResponse.json({ ok: false, error: "User not connected to Strava" }, { status: 400 });
  }

  const athleteId = Number((accRows[0] as any).athlete_id);
  const accessToken = await refreshIfNeeded(athleteId);

  const after = Math.floor((Date.now() - nDays * 24 * 3600 * 1000) / 1000);

  // Pull activities
  const url = new URL("https://www.strava.com/api/v3/athlete/activities");
  url.searchParams.set("after", String(after));
  url.searchParams.set("per_page", "200");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava activities failed: ${res.status} ${await res.text()}`);

  const activities = (await res.json()) as any[];

  // Upsert ke DB
  for (const a of activities) {
    await sql`
      INSERT INTO activities (
        strava_activity_id, athlete_id, telegram_user_id,
        type, name, start_date, distance_m, moving_time_s, elev_gain_m, avg_hr, data
      )
      VALUES (
        ${Number(a.id)}, ${athleteId}, ${telegramUserId},
        ${a.type || null}, ${a.name || null}, ${a.start_date ? new Date(a.start_date) : null},
        ${a.distance ? Math.round(a.distance) : null},
        ${a.moving_time ?? null},
        ${a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null},
        ${a.average_heartrate ? Math.round(a.average_heartrate) : null},
        ${a}
      )
      ON CONFLICT (strava_activity_id)
      DO UPDATE SET
        type = EXCLUDED.type,
        name = EXCLUDED.name,
        start_date = EXCLUDED.start_date,
        distance_m = EXCLUDED.distance_m,
        moving_time_s = EXCLUDED.moving_time_s,
        elev_gain_m = EXCLUDED.elev_gain_m,
        avg_hr = EXCLUDED.avg_hr,
        data = EXCLUDED.data
    `;
  }

  return NextResponse.json({ ok: true, days: nDays, imported: activities.length });
}
