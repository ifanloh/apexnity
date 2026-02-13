import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getValidAccessTokenByAthleteId } from "@/lib/strava";
import { sendTelegramMessage } from "@/lib/telegram";
import { buildActivityReport } from "@/lib/coach";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret");
  if (process.env.INTERNAL_JOB_SECRET && secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const e = await req.json();
  const objectType = e?.object_type;
  const aspectType = e?.aspect_type;
  const activityId = Number(e?.object_id);
  const athleteId = Number(e?.owner_id);

  if (objectType !== "activity" || !activityId || !athleteId) return NextResponse.json({ ok: true });

  const r = await sql`
    SELECT s.telegram_user_id, u.telegram_chat_id
    FROM strava_accounts s
    JOIN users u ON u.telegram_user_id = s.telegram_user_id
    WHERE s.athlete_id = ${athleteId}
    LIMIT 1
  `;
  if (r.length === 0) return NextResponse.json({ ok: true });

  const telegramUserId = Number((r[0] as any).telegram_user_id);
  const chatId = Number((r[0] as any).telegram_chat_id);

  if (aspectType === "delete") {
    await sql`DELETE FROM activities WHERE strava_activity_id = ${activityId}`;
    await sendTelegramMessage(chatId, `🗑️ Activity dihapus (ID: ${activityId}).`);
    return NextResponse.json({ ok: true });
  }

  const token = await getValidAccessTokenByAthleteId(athleteId);
  if (!token) return NextResponse.json({ ok: true });

  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) {
    await sendTelegramMessage(chatId, `⚠️ Gagal ambil detail activity: ${res.status}`);
    return NextResponse.json({ ok: false });
  }

  const a = await res.json();

  await sql`
    INSERT INTO activities (
      strava_activity_id, athlete_id, telegram_user_id,
      type, name, start_date, distance_m, moving_time_s, elev_gain_m, avg_hr, data
    )
    VALUES (
      ${activityId}, ${athleteId}, ${telegramUserId},
      ${a.type ?? null}, ${a.name ?? null}, ${a.start_date ?? null},
      ${a.distance ? Math.round(a.distance) : null},
      ${a.moving_time ? Math.round(a.moving_time) : null},
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

  const report = buildActivityReport({
    name: a.name,
    type: a.type,
    distance_m: a.distance ? Math.round(a.distance) : 0,
    moving_time_s: a.moving_time ? Math.round(a.moving_time) : 0,
    elev_gain_m: a.total_elevation_gain ? Math.round(a.total_elevation_gain) : 0,
    avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
  });

  await sendTelegramMessage(chatId, report);
  return NextResponse.json({ ok: true });
}
