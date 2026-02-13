import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sendTelegramMessage } from "@/lib/telegram";
import { createOauthState, buildStravaAuthorizeUrl } from "@/lib/strava";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    // Always return 200 to Telegram to avoid retries
    return NextResponse.json({ ok: true });
  }

  const update = await req.json();
  const msg = update?.message;
  if (!msg?.chat?.id || !msg?.from?.id) return NextResponse.json({ ok: true });

  const chatId = msg.chat.id as number;
  const telegramUserId = msg.from.id as number;
  const text = (msg.text || "").trim();

  await sql`
    INSERT INTO users (telegram_user_id, telegram_chat_id)
    VALUES (${telegramUserId}, ${chatId})
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = NOW()
  `;

  // Helper: plain text only (no markdown chars)
  const reply = async (t: string) => {
    await sendTelegramMessage(chatId, t);
  };

  if (text.startsWith("/start")) {
    await reply(
      [
        "Halo! Aku AI Pro Trainer kamu 👟🚴‍♂️🏋️‍♂️",
        "",
        "Perintah:",
        "/connect  -> sambungkan Strava",
        "/report   -> report aktivitas terakhir",
        "/checkin sleep=7 soreness=2 mood=4 note=ok",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  if (text.startsWith("/connect")) {
    if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_REDIRECT_URL) {
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

  if (text.startsWith("/report")) {
    const rows = await sql`
      SELECT name, type, distance_m, moving_time_s, elev_gain_m, avg_hr, start_date
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
      ORDER BY start_date DESC NULLS LAST
      LIMIT 1
    `;

    if (rows.length === 0) {
      await reply("Belum ada aktivitas tersimpan. Coba /connect dulu ya.");
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

    if (text.startsWith("/sync")) {
    // contoh: /sync 7d
    const m = text.match(/\/sync\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    await sendTelegramMessage(
      chatId,
      `Konfirmasi: aku akan menarik histori aktivitas ${days} hari terakhir dari Strava dan membuat insight. Balas: /syncgo ${days}`
    );
    return NextResponse.json({ ok: true });
  }

  if (text.startsWith("/syncgo")) {
    const m = text.match(/\/syncgo\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    // panggil job internal backfill
    const baseUrl = process.env.APP_BASE_URL;
    const jobSecret = process.env.INTERNAL_JOB_SECRET;
    if (!baseUrl || !jobSecret) {
      await sendTelegramMessage(chatId, "Server belum lengkap konfigurasi APP_BASE_URL / INTERNAL_JOB_SECRET.");
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
      await sendTelegramMessage(chatId, `Sync gagal: ${res.status}\n${payload}`);
      return NextResponse.json({ ok: true });
    }

    await sendTelegramMessage(chatId, `✅ Sync sukses.\n${payload}\n\nKetik /insight ${days}d untuk lihat insight.`);
    return NextResponse.json({ ok: true });
  }

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
      await sendTelegramMessage(chatId, `Belum ada data ${days} hari terakhir. Mau tarik histori? ketik: /sync ${days}d`);
      return NextResponse.json({ ok: true });
    }

    const km = (Number(r.dist_m) / 1000).toFixed(1);
    const hrs = (Number(r.time_s) / 3600).toFixed(1);
    const elev = Number(r.elev_m);

    // Insight sederhana (bisa kamu kembangkan)
    const avgKm = (Number(r.dist_m) / 1000 / sessions).toFixed(1);
    const avgElev = Math.round(elev / sessions);

    await sendTelegramMessage(
      chatId,
      [
        `📈 Insight ${days} hari terakhir`,
        `Sesi: ${sessions}`,
        `Total jarak: ${km} km`,
        `Total durasi: ${hrs} jam`,
        `Total elev: ${elev} m`,
        "",
        `Rata-rata per sesi: ${avgKm} km, elev ${avgElev} m`,
        `Saran: kalau hari ini belum latihan, pilih 1 sesi easy 30–45 menit atau strength ringan 20–30 menit.`,
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

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

  await reply("Perintah tersedia: /connect, /report, /checkin");
  return NextResponse.json({ ok: true });
}

