import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getValidAccessTokenByAthleteId } from "@/lib/strava";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret");
  if (process.env.INTERNAL_JOB_SECRET && secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { telegramUserId, athleteId } = (await req.json()) as { telegramUserId: number; athleteId: number };
  if (!telegramUserId || !athleteId) return NextResponse.json({ ok: false }, { status: 400 });

  const u = await sql`SELECT telegram_chat_id FROM users WHERE telegram_user_id = ${telegramUserId} LIMIT 1`;
  const chatId = Number((u[0] as any).telegram_chat_id);

  const token = await getValidAccessTokenByAthleteId(athleteId);
  if (!token) return NextResponse.json({ ok: true });

  const after = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50&page=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (!res.ok) {
    await sendTelegramMessage(chatId, `⚠️ Initial sync gagal: ${res.status}`);
    return NextResponse.json({ ok: false });
  }

  const list = (await res.json()) as any[];

  for (const a of list) {
    const activityId = Number(a.id);
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
      ON CONFLICT (strava_activity_id) DO NOTHING
    `;
  }

  await sendTelegramMessage(chatId, `✅ Initial sync selesai. Tersimpan ${list.length} activity (30 hari terakhir).`);
  return NextResponse.json({ ok: true, count: list.length });
}
