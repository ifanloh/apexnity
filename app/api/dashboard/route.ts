// app/api/dashboard/route.ts
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { summarizeLoad, getCheckinSignals } from "@/lib/training";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ownerId = process.env.OWNER_TELEGRAM_ID;
    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "Missing OWNER_TELEGRAM_ID" },
        { status: 500 }
      );
    }
    const telegramUserId = Number(ownerId);

    // profile
    const uRows = await sql`
      SELECT telegram_user_id, goal_text, goal_date, preferred_sports, training_days_per_week, auto_coach_enabled
      FROM users
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;
    const profile = (uRows[0] as any) || null;

    // last activity
    const aRows = await sql`
      SELECT name, type, distance_m, moving_time_s, elev_gain_m, avg_hr, start_date
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
      ORDER BY start_date DESC NULLS LAST
      LIMIT 1
    `;
    const lastActivity = (aRows[0] as any) || null;

    // 7d summary
    const summary7d = await summarizeLoad(telegramUserId, 7);

    // checkins + fatigue
    const { fatigue, checkins } = await getCheckinSignals(telegramUserId, 7);

    // strava connected + info
    const sRows = await sql`
      SELECT athlete_id, scopes, expires_at
      FROM strava_accounts
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;

    const stravaConnected = sRows.length > 0;
    const stravaInfo =
      sRows.length > 0
        ? {
            athlete_id: Number((sRows[0] as any).athlete_id),
            scopes: String((sRows[0] as any).scopes || ""),
            expires_at: Number((sRows[0] as any).expires_at || 0),
          }
        : null;

    return NextResponse.json({
      ok: true,
      profile,
      stravaConnected,
      stravaInfo,
      lastActivity,
      summary7d,
      fatigueIndex: fatigue,
      checkins7d: checkins || [],
      now: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
