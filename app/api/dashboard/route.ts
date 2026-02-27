import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { summarizeLoad, getCheckinSignals } from "@/lib/training";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (!ownerId) {
    return NextResponse.json({ ok: false, error: "Missing OWNER_TELEGRAM_ID" }, { status: 500 });
  }
  const telegramUserId = Number(ownerId);

  // profile
  const uRows = await sql`
    SELECT telegram_user_id, goal_text, goal_date, preferred_sports, training_days_per_week, auto_coach_enabled
    FROM users
    WHERE telegram_user_id = ${telegramUserId}
    LIMIT 1
  `;
  const profile = uRows[0] as any;

  // last activity
  const aRows = await sql`
    SELECT name, type, distance_m, moving_time_s, elev_gain_m, avg_hr, start_date
    FROM activities
    WHERE telegram_user_id = ${telegramUserId}
    ORDER BY start_date DESC NULLS LAST
    LIMIT 1
  `;
  const lastActivity = aRows[0] as any;

  // 7d summary
  const sum7 = await summarizeLoad(telegramUserId, 7);

  // checkins
  const { fatigue, checkins } = await getCheckinSignals(telegramUserId, 7);

  // strava connected? (cek token ada)
const sRows = await sql`
  SELECT athlete_id, scopes, expires_at
  FROM strava_accounts
  WHERE telegram_user_id = ${telegramUserId}
  LIMIT 1
`;
const stravaConnected = sRows.length > 0;
const stravaInfo = sRows.length
  ? {
      athlete_id: (sRows[0] as any).athlete_id,
      scopes: (sRows[0] as any).scopes,
      expires_at: (sRows[0] as any).expires_at,
    }
  : null;

  return NextResponse.json({
    ok: true,
    profile: profile || null,
    stravaConnected,
    stravaInfo,
    lastActivity: lastActivity || null,
    summary7d: sum7,
    fatigueIndex: fatigue,
    checkins7d: checkins || [],
    now: new Date().toISOString(),
  });
}
