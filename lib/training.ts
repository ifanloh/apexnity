import { sql } from "@/lib/db";

export type LoadSummary = {
  days: number;
  sessions: number;
  total_km: number;
  total_hours: number;
  total_elev_m: number;
  by_type: Record<string, { sessions: number; km: number; hours: number; elev_m: number }>;
};

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function pctChange(curr: number, prev: number) {
  if (!prev || prev <= 0) return null;
  return (curr - prev) / prev;
}

export async function computeDailyLoad(telegramUserId: number, day: string) {
  // day format: YYYY-MM-DD
  const rows = await sql`
    SELECT
      COUNT(*)::int AS sessions,
      COALESCE(SUM(distance_m),0)::bigint AS dist_m,
      COALESCE(SUM(moving_time_s),0)::bigint AS time_s,
      COALESCE(SUM(elev_gain_m),0)::bigint AS elev_m,
      CASE WHEN COUNT(avg_hr) > 0 THEN ROUND(AVG(avg_hr))::int ELSE NULL END AS avg_hr_avg
    FROM activities
    WHERE telegram_user_id = ${telegramUserId}
      AND start_date >= (${day}::date)
      AND start_date < (${day}::date + INTERVAL '1 day')
  `;

  const r = rows[0] as any;

  await sql`
    INSERT INTO daily_load (telegram_user_id, day, sessions, dist_m, time_s, elev_m, avg_hr_avg, updated_at)
    VALUES (${telegramUserId}, ${day}::date, ${r.sessions}, ${r.dist_m}, ${r.time_s}, ${r.elev_m}, ${r.avg_hr_avg}, NOW())
    ON CONFLICT (telegram_user_id, day)
    DO UPDATE SET
      sessions = EXCLUDED.sessions,
      dist_m = EXCLUDED.dist_m,
      time_s = EXCLUDED.time_s,
      elev_m = EXCLUDED.elev_m,
      avg_hr_avg = EXCLUDED.avg_hr_avg,
      updated_at = NOW()
  `;
}

export async function summarizeLoad(telegramUserId: number, days: number): Promise<LoadSummary> {
  const rows = await sql`
    SELECT type,
           COUNT(*)::int AS sessions,
           COALESCE(SUM(distance_m),0)::bigint AS dist_m,
           COALESCE(SUM(moving_time_s),0)::bigint AS time_s,
           COALESCE(SUM(elev_gain_m),0)::bigint AS elev_m
    FROM activities
    WHERE telegram_user_id = ${telegramUserId}
      AND start_date >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY type
  `;

  const by_type: LoadSummary["by_type"] = {};
  let sessions = 0;
  let dist_m = 0;
  let time_s = 0;
  let elev_m = 0;

  for (const row of rows as any[]) {
    const t = String(row.type || "Other");
    const s = Number(row.sessions || 0);
    const dm = Number(row.dist_m || 0);
    const ts = Number(row.time_s || 0);
    const em = Number(row.elev_m || 0);

    sessions += s;
    dist_m += dm;
    time_s += ts;
    elev_m += em;

    by_type[t] = {
      sessions: s,
      km: Number((dm / 1000).toFixed(1)),
      hours: Number((ts / 3600).toFixed(1)),
      elev_m: Math.round(em),
    };
  }

  return {
    days,
    sessions,
    total_km: Number((dist_m / 1000).toFixed(1)),
    total_hours: Number((time_s / 3600).toFixed(1)),
    total_elev_m: Math.round(elev_m),
    by_type,
  };
}

export async function getCheckinSignals(telegramUserId: number, days: number) {
  const rows = await sql`
    SELECT day, sleep_hours, soreness, mood
    FROM checkins
    WHERE telegram_user_id = ${telegramUserId}
      AND day >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    ORDER BY day DESC
    LIMIT 14
  `;

  // Simple heuristics: fatigue index 0..100
  let fatigue = 35; // baseline
  let n = 0;

  for (const r of rows as any[]) {
    n++;
    const sleep = r.sleep_hours != null ? Number(r.sleep_hours) : null;
    const soreness = r.soreness != null ? Number(r.soreness) : null; // asumsi 1..5
    const mood = r.mood != null ? Number(r.mood) : null; // asumsi 1..5

    if (sleep != null) {
      if (sleep < 6) fatigue += 8;
      else if (sleep >= 7.5) fatigue -= 5;
    }
    if (soreness != null) fatigue += (soreness - 2) * 6;
    if (mood != null) fatigue += (3 - mood) * 4;
  }

  if (n === 0) fatigue += 5; // no data: slightly conservative
  fatigue = clamp(Math.round(fatigue), 0, 100);

  return { fatigue, checkins: rows as any[] };
}
