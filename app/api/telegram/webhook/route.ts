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

