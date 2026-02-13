import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { computeDailyLoad } from "@/lib/training";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-job-secret");
  if (!process.env.INTERNAL_JOB_SECRET || secret !== process.env.INTERNAL_JOB_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { telegramUserId, days } = await req.json();
  const nDays = Math.max(1, Math.min(30, Number(days || 14)));

  // generate day list (UTC date-based)
  for (let i = 0; i < nDays; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const day = `${yyyy}-${mm}-${dd}`;
    await computeDailyLoad(Number(telegramUserId), day);
  }

  // return a small summary
  const rows = await sql`
    SELECT day, sessions, dist_m, time_s, elev_m
    FROM daily_load
    WHERE telegram_user_id = ${telegramUserId}
    ORDER BY day DESC
    LIMIT 7
  `;

  return NextResponse.json({ ok: true, updated_days: nDays, preview: rows });
}
