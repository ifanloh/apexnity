import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { summarizeLoad, pctChange, getCheckinSignals } from "@/lib/training";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-job-secret");
  if (!process.env.INTERNAL_JOB_SECRET || secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // get users to coach
  const users = await sql`
    SELECT telegram_user_id, telegram_chat_id, auto_coach_enabled, training_days_per_week
    FROM users
    WHERE telegram_chat_id IS NOT NULL
      AND COALESCE(auto_coach_enabled, TRUE) = TRUE
    LIMIT 500
  `;

  let nudged = 0;
  let warned = 0;

  for (const u of users as any[]) {
    const userId = Number(u.telegram_user_id);
    const chatId = Number(u.telegram_chat_id);

    // last activity time
    const lastAct = await sql`
      SELECT start_date
      FROM activities
      WHERE telegram_user_id = ${userId}
      ORDER BY start_date DESC NULLS LAST
      LIMIT 1
    `;
    const lastDate = lastAct.length ? (lastAct[0] as any).start_date : null;

    // weekly trend
    const w1 = await summarizeLoad(userId, 7);
    const w2 = await summarizeLoad(userId, 14); // contains 14 days, we’ll compute previous 7 via query
    const prevRows = await sql`
      SELECT
        COUNT(*)::int AS sessions,
        COALESCE(SUM(distance_m),0)::bigint AS dist_m,
        COALESCE(SUM(moving_time_s),0)::bigint AS time_s
      FROM activities
      WHERE telegram_user_id = ${userId}
        AND start_date >= NOW() - (14 * INTERVAL '1 day')
        AND start_date < NOW() - (7 * INTERVAL '1 day')
    `;
    const prev = prevRows[0] as any;
    const prevHours = Number(prev.time_s || 0) / 3600;
    const currHours = w1.total_hours;

    const delta = pctChange(currHours, prevHours); // null if prev=0
    const { fatigue } = await getCheckinSignals(userId, 7);

    // spam guard state
    const stRows = await sql`SELECT last_nudge_at, last_warning_at FROM coach_state WHERE telegram_user_id = ${userId}`;
    const st = stRows.length ? (stRows[0] as any) : { last_nudge_at: null, last_warning_at: null };

    const now = Date.now();
    const nudgeCooldownH = 18;
    const warnCooldownH = 24;

    const canNudge =
      !st.last_nudge_at || (now - new Date(st.last_nudge_at).getTime()) > nudgeCooldownH * 3600 * 1000;
    const canWarn =
      !st.last_warning_at || (now - new Date(st.last_warning_at).getTime()) > warnCooldownH * 3600 * 1000;

    // Rule 1: no training for 3 days -> nudge
    if (canNudge) {
      if (!lastDate) {
        await sendTelegramMessage(chatId, "Kamu belum punya aktivitas tersimpan. Kalau sudah connect Strava: /sync 7d untuk tarik histori, lalu /aiinsight 7d.");
        nudged++;
        await sql`
          INSERT INTO coach_state (telegram_user_id, last_nudge_at, updated_at)
          VALUES (${userId}, NOW(), NOW())
          ON CONFLICT (telegram_user_id) DO UPDATE SET last_nudge_at = NOW(), updated_at = NOW()
        `;
        continue;
      }

      const hoursSince = (now - new Date(lastDate).getTime()) / 3600000;
      if (hoursSince >= 72) {
        await sendTelegramMessage(
          chatId,
          `Reminder coach: sudah ${Math.round(hoursSince)} jam sejak latihan terakhir.\nKalau butuh saran: /aiinsight 7d`
        );
        nudged++;
        await sql`
          INSERT INTO coach_state (telegram_user_id, last_nudge_at, updated_at)
          VALUES (${userId}, NOW(), NOW())
          ON CONFLICT (telegram_user_id) DO UPDATE SET last_nudge_at = NOW(), updated_at = NOW()
        `;
      }
    }

    // Rule 2: load spike warning (+30% weekly hours) OR fatigue high
    if (canWarn) {
      const spike = delta != null && delta > 0.3;
      const highFatigue = fatigue >= 75;

      if (spike || highFatigue) {
        const parts: string[] = ["⚠️ Warning coach:"];
        if (spike) parts.push(`Load minggu ini naik ${(delta! * 100).toFixed(0)}% vs minggu lalu (berisiko overuse).`);
        if (highFatigue) parts.push(`Fatigue index tinggi (${fatigue}/100) dari check-in.`);
        parts.push("Saran cepat: 1 hari recovery / easy Z2 + mobilitas 10–15 menit.");
        parts.push("Cek detail: /aiinsight 7d");

        await sendTelegramMessage(chatId, parts.join("\n"));
        warned++;

        await sql`
          INSERT INTO coach_state (telegram_user_id, last_warning_at, updated_at)
          VALUES (${userId}, NOW(), NOW())
          ON CONFLICT (telegram_user_id) DO UPDATE SET last_warning_at = NOW(), updated_at = NOW()
        `;
      }
    }
  }

  return NextResponse.json({ ok: true, users: users.length, nudged, warned });
}
