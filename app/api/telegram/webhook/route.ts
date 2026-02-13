import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sendTelegramMessage } from "@/lib/telegram";
import { createOauthState, buildStravaAuthorizeUrl } from "@/lib/strava";
import { generateAiInsight } from "@/lib/openai";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Telegram secret check (optional)
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return NextResponse.json({ ok: true });
  }

  const update = await req.json();
  const msg = update?.message;
  if (!msg?.chat?.id || !msg?.from?.id) return NextResponse.json({ ok: true });

  const chatId = msg.chat.id as number;
  const telegramUserId = msg.from.id as number;
  const text = (msg.text || "").trim();

  // Upsert user mapping
  await sql`
    INSERT INTO users (telegram_user_id, telegram_chat_id)
    VALUES (${telegramUserId}, ${chatId})
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = NOW()
  `;

  const reply = async (t: string) => {
    await sendTelegramMessage(chatId, t);
  };

  // -------------------------
  // /start
  // -------------------------
  if (text.startsWith("/start")) {
    await reply(
      [
        "Halo! Aku AI Pro Trainer kamu 👟🚴‍♂️🏋️‍♂️",
        "",
        "Perintah:",
        "/connect            -> sambungkan Strava",
        "/report             -> aktivitas terakhir (dari DB)",
        "/sync 7d            -> minta approval tarik histori 7 hari",
        "/syncgo 7           -> eksekusi tarik histori (setelah approval)",
        "/insight 7d          -> insight basic (tanpa AI)",
        "/aiinsight 7d        -> insight pakai AI (OpenAI)",
        "/checkin sleep=7 soreness=2 mood=4 note=ok",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // /connect
  // -------------------------
  if (text.startsWith("/connect")) {
    if (
      !process.env.STRAVA_CLIENT_ID ||
      !process.env.STRAVA_CLIENT_SECRET ||
      !process.env.STRAVA_REDIRECT_URL
    ) {
      await reply(
        "Konfigurasi Strava belum lengkap di server. Pastikan STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, dan STRAVA_REDIRECT_URL sudah diisi di Vercel lalu redeploy."
      );
      return NextResponse.json({ ok: true });
    }

    const state = await createOauthState(telegramUserId);
    const url = buildStravaAuthorizeUrl(state);

    await reply(
      [
        "Klik untuk connect Strava:",
        url,
        "",
        "Setelah connect, balik lagi ke Telegram.",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // /report
  // -------------------------
  if (text.startsWith("/report")) {
    const rows = await sql`
      SELECT name, type, distance_m, moving_time_s, elev_gain_m, avg_hr, start_date
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
      ORDER BY start_date DESC NULLS LAST
      LIMIT 1
    `;

    if (rows.length === 0) {
      await reply(
        "Belum ada aktivitas tersimpan di database.\nKalau mau tarik histori 7 hari terakhir: /sync 7d"
      );
    } else {
      const a = rows[0] as any;
      await reply(
        [
          "Last Activity",
          `Nama: ${a.name || "-"}`,
          `Tipe: ${a.type || "-"}`,
          `Jarak: ${((a.distance_m || 0) / 1000).toFixed(2)} km`,
          `Durasi: ${Math.round((a.moving_time_s || 0) / 60)} min`,
          `Elev: ${a.elev_gain_m ?? 0} m`,
          a.avg_hr ? `Avg HR: ${a.avg_hr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // IMPORTANT ORDER:
  // /syncgo must be before /sync
  // -------------------------
  if (text.startsWith("/syncgo")) {
    const m = text.match(/\/syncgo\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    const baseUrl = process.env.APP_BASE_URL;
    const jobSecret = process.env.INTERNAL_JOB_SECRET;

    if (!baseUrl || !jobSecret) {
      await reply("Server belum lengkap konfigurasi APP_BASE_URL / INTERNAL_JOB_SECRET.");
      return NextResponse.json({ ok: true });
    }

    const res = await fetch(`${baseUrl}/api/jobs/backfill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-job-secret": jobSecret,
      },
      body: JSON.stringify({ telegramUserId, days }),
    });

    const payload = await res.text();
    if (!res.ok) {
      await reply(`Sync gagal: ${res.status}\n${payload}`);
      return NextResponse.json({ ok: true });
    }

    await reply(`✅ Sync sukses.\n${payload}\n\nKetik /insight ${days}d atau /aiinsight ${days}d`);
    return NextResponse.json({ ok: true });
  }

  if (text.startsWith("/sync")) {
    const m = text.match(/\/sync\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    await reply(
      `Konfirmasi: aku akan menarik histori aktivitas ${days} hari terakhir dari Strava.\nBalas: /syncgo ${days}`
    );
    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // /insight (basic, rule-based)
  // -------------------------
  if (text.startsWith("/insight")) {
    const m = text.match(/\/insight\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    const rows = await sql`
      SELECT
        COUNT(*)::int AS sessions,
        COALESCE(SUM(distance_m),0)::int AS dist_m,
        COALESCE(SUM(moving_time_s),0)::int AS time_s,
        COALESCE(SUM(elev_gain_m),0)::int AS elev_m
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
        AND start_date >= NOW() - (${days}::int * INTERVAL '1 day')
    `;

    const r = rows[0] as any;
    const sessions = r.sessions || 0;

    if (sessions === 0) {
      await reply(`Belum ada data ${days} hari terakhir. Mau tarik histori? ketik: /sync ${days}d`);
      return NextResponse.json({ ok: true });
    }

    const km = (Number(r.dist_m) / 1000).toFixed(1);
    const hrs = (Number(r.time_s) / 3600).toFixed(1);
    const elev = Number(r.elev_m);

    const avgKm = (Number(r.dist_m) / 1000 / sessions).toFixed(1);
    const avgElev = Math.round(elev / sessions);

    await reply(
      [
        `📈 Insight ${days} hari terakhir (basic)`,
        `Sesi: ${sessions}`,
        `Total jarak: ${km} km`,
        `Total durasi: ${hrs} jam`,
        `Total elev: ${elev} m`,
        "",
        `Rata-rata per sesi: ${avgKm} km, elev ${avgElev} m`,
        "Saran: kalau hari ini belum latihan, pilih easy 30–45 menit atau strength ringan 20–30 menit.",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // /aiinsight (OpenAI)
  // -------------------------
  if (text.startsWith("/aiinsight")) {
    const m = text.match(/\/aiinsight\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    const actRows = await sql`
      SELECT type, name, start_date, distance_m, moving_time_s, elev_gain_m, avg_hr
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
        AND start_date >= NOW() - (${days}::int * INTERVAL '1 day')
      ORDER BY start_date DESC NULLS LAST
      LIMIT 50
    `;

    if (actRows.length === 0) {
      await reply(
        `Belum ada data aktivitas ${days} hari terakhir di DB.\nKalau mau tarik histori: /sync ${days}d`
      );
      return NextResponse.json({ ok: true });
    }

    const chkRows = await sql`
      SELECT day, sleep_hours, soreness, mood, note
      FROM checkins
      WHERE telegram_user_id = ${telegramUserId}
        AND day >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
      ORDER BY day DESC
      LIMIT 60
    `;

    // Summarize
    let sessions = 0;
    let total_m = 0;
    let total_s = 0;
    let total_elev = 0;

    const byType: Record<
      string,
      { sessions: number; km: number; hours: number; elev_m: number }
    > = {};

    const lastActs = (actRows as any[]).slice(0, 7).map((a) => {
      const km = Number((Number(a.distance_m || 0) / 1000).toFixed(2));
      const minutes = Math.round(Number(a.moving_time_s || 0) / 60);
      const elev_m = Number(a.elev_gain_m ?? 0);
      const avg_hr =
        a.avg_hr !== null && a.avg_hr !== undefined ? Number(a.avg_hr) : null;

      return {
        start_date: a.start_date ? new Date(a.start_date).toISOString() : null,
        name: a.name || null,
        type: a.type || null,
        km,
        minutes,
        elev_m,
        avg_hr,
      };
    });

    for (const a of actRows as any[]) {
      sessions += 1;
      const m0 = Number(a.distance_m || 0);
      const s0 = Number(a.moving_time_s || 0);
      const e0 = Number(a.elev_gain_m ?? 0);

      total_m += m0;
      total_s += s0;
      total_elev += e0;

      const t = String(a.type || "Other");
      if (!byType[t]) byType[t] = { sessions: 0, km: 0, hours: 0, elev_m: 0 };
      byType[t].sessions += 1;
      byType[t].km += m0 / 1000;
      byType[t].hours += s0 / 3600;
      byType[t].elev_m += e0;
    }

    for (const k of Object.keys(byType)) {
      byType[k].km = Number(byType[k].km.toFixed(1));
      byType[k].hours = Number(byType[k].hours.toFixed(1));
      byType[k].elev_m = Math.round(byType[k].elev_m);
    }

    const payload = {
      days,
      summary: {
        sessions,
        total_km: Number((total_m / 1000).toFixed(1)),
        total_hours: Number((total_s / 3600).toFixed(1)),
        total_elev_m: Math.round(total_elev),
        by_type: byType,
        last_7_activities: lastActs,
        checkins_last_days: (chkRows as any[]).map((c) => ({
          day: String(c.day),
          sleep_hours:
            c.sleep_hours !== null && c.sleep_hours !== undefined
              ? Number(c.sleep_hours)
              : null,
          soreness:
            c.soreness !== null && c.soreness !== undefined
              ? Number(c.soreness)
              : null,
          mood:
            c.mood !== null && c.mood !== undefined ? Number(c.mood) : null,
          note: c.note ? String(c.note) : null,
        })),
      },
    };

    try {
      await reply(`🤖 AI Insight ${days} hari\n(analisa sedang dibuat...)`);
      const aiText = await generateAiInsight(payload as any);
      await reply(`🤖 AI Insight ${days} hari\n\n${aiText}`);
    } catch (e: any) {
      await reply(`AI gagal: ${e?.message || String(e)}`);
    }

    return NextResponse.json({ ok: true });
  }

  // -------------------------
  // /checkin
  // -------------------------
  if (text.startsWith("/checkin")) {
    const args = Object.fromEntries(
      text
        .replace("/checkin", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((kv: string) => {
          const [k, ...rest] = kv.split("=");
          return [k, rest.join("=")];
        })
    );

    const sleep = args.sleep ? Number(args.sleep) : null;
    const soreness = args.soreness ? Number(args.soreness) : null;
    const mood = args.mood ? Number(args.mood) : null;
    const note = args.note ? String(args.note) : null;

    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const day = `${yyyy}-${mm}-${dd}`;

    await sql`
      INSERT INTO checkins (telegram_user_id, day, sleep_hours, soreness, mood, note)
      VALUES (${telegramUserId}, ${day}, ${sleep}, ${soreness}, ${mood}, ${note})
      ON CONFLICT (telegram_user_id, day)
      DO UPDATE SET sleep_hours = EXCLUDED.sleep_hours,
                    soreness = EXCLUDED.soreness,
                    mood = EXCLUDED.mood,
                    note = EXCLUDED.note
    `;

    await reply("✅ Check-in tersimpan. Makasih!");
    return NextResponse.json({ ok: true });
  }

  // default
  await reply("Perintah tersedia: /connect, /report, /sync, /insight, /aiinsight, /checkin");
  return NextResponse.json({ ok: true });
}
