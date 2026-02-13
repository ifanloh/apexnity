import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sendTelegramMessage } from "@/lib/telegram";
import { createOauthState, buildStravaAuthorizeUrl } from "@/lib/strava";
import { generateAiInsight } from "@/lib/openai"; // (isi file ini sudah kamu ganti ke Groq)
import { summarizeLoad, pctChange, getCheckinSignals } from "@/lib/training";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
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

  const reply = async (t: string) => sendTelegramMessage(chatId, t);

  // /start
  if (text.startsWith("/start")) {
    await reply(
      [
        "Halo! Aku AI Pro Trainer kamu 👟🚴‍♂️🏋️‍♂️",
        "",
        "Perintah utama:",
        "/connect               -> sambungkan Strava",
        "/sync 7d               -> minta approval tarik histori",
        "/syncgo 7              -> eksekusi tarik histori",
        "/insight 7d             -> insight basic",
        "/aiinsight 7d           -> insight AI (Groq)",
        "/plan 7d                -> generate weekly plan 7 hari",
        "",
        "Profile & coaching:",
        "/profile                -> lihat profile",
        "/setgoal text=UTMB110K date=2026-08-15",
        "/setpref sports=trail,cycling,strength days=5",
        "/autocoach on|off",
        "",
        "Check-in:",
        "/checkin sleep=7 soreness=2 mood=4 note=ok",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // /profile
  if (text.startsWith("/profile")) {
    const rows = await sql`
      SELECT goal_text, goal_date, preferred_sports, training_days_per_week, auto_coach_enabled
      FROM users
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;
    const u = rows[0] as any;
    await reply(
      [
        "Profile kamu:",
        `Goal: ${u?.goal_text || "-"}`,
        `Goal date: ${u?.goal_date ? String(u.goal_date).slice(0, 10) : "-"}`,
        `Preferred sports: ${u?.preferred_sports || "-"}`,
        `Training days/week: ${u?.training_days_per_week ?? "-"}`,
        `Auto coach: ${u?.auto_coach_enabled === false ? "OFF" : "ON"}`,
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // /setgoal text=... date=YYYY-MM-DD
  if (text.startsWith("/setgoal")) {
    const args = Object.fromEntries(
      text
        .replace("/setgoal", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((kv: string) => {
          const [k, ...rest] = kv.split("=");
          return [k, rest.join("=")];
        })
    );

    const goalText = args.text ? String(args.text) : null;
    const goalDate = args.date ? String(args.date) : null;

    await sql`
      UPDATE users
      SET goal_text = ${goalText},
          goal_date = ${goalDate ? (goalDate as any) : null},
          updated_at = NOW()
      WHERE telegram_user_id = ${telegramUserId}
    `;

    await reply("✅ Goal tersimpan. Coba /profile untuk cek.");
    return NextResponse.json({ ok: true });
  }

  // /setpref sports=trail,cycling,strength days=5
  if (text.startsWith("/setpref")) {
    const args = Object.fromEntries(
      text
        .replace("/setpref", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((kv: string) => {
          const [k, ...rest] = kv.split("=");
          return [k, rest.join("=")];
        })
    );

    const sports = args.sports ? String(args.sports) : null;
    const days = args.days ? Number(args.days) : null;

    await sql`
      UPDATE users
      SET preferred_sports = ${sports},
          training_days_per_week = ${days},
          updated_at = NOW()
      WHERE telegram_user_id = ${telegramUserId}
    `;

    await reply("✅ Preferensi tersimpan. Coba /profile untuk cek.");
    return NextResponse.json({ ok: true });
  }

  // /autocoach on|off
  if (text.startsWith("/autocoach")) {
    const on = /\/autocoach\s+on/i.test(text);
    const off = /\/autocoach\s+off/i.test(text);
    if (!on && !off) {
      await reply("Format: /autocoach on atau /autocoach off");
      return NextResponse.json({ ok: true });
    }

    await sql`
      UPDATE users
      SET auto_coach_enabled = ${on ? true : false},
          updated_at = NOW()
      WHERE telegram_user_id = ${telegramUserId}
    `;
    await reply(`✅ Auto coach ${on ? "ON" : "OFF"}.`);
    return NextResponse.json({ ok: true });
  }

  // /connect
  if (text.startsWith("/connect")) {
    if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET || !process.env.STRAVA_REDIRECT_URL) {
      await reply(
        "Konfigurasi Strava belum lengkap di server. Pastikan STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REDIRECT_URL sudah diisi di Vercel lalu redeploy."
      );
      return NextResponse.json({ ok: true });
    }

    const state = await createOauthState(telegramUserId);
    const url = buildStravaAuthorizeUrl(state);
    await reply(["Klik untuk connect Strava:", url, "", "Setelah connect, balik lagi ke Telegram."].join("\n"));
    return NextResponse.json({ ok: true });
  }

  // /report
  if (text.startsWith("/report")) {
    const rows = await sql`
      SELECT name, type, distance_m, moving_time_s, elev_gain_m, avg_hr, start_date
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
      ORDER BY start_date DESC NULLS LAST
      LIMIT 1
    `;

    if (rows.length === 0) {
      await reply("Belum ada aktivitas tersimpan. Kalau mau tarik histori: /sync 7d");
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

  // /syncgo must be before /sync
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
      headers: { "Content-Type": "application/json", "x-internal-job-secret": jobSecret },
      body: JSON.stringify({ telegramUserId, days }),
    });

    const payload = await res.text();
    if (!res.ok) {
      await reply(`Sync gagal: ${res.status}\n${payload}`);
      return NextResponse.json({ ok: true });
    }

    // optional: update daily aggregates for last 14 days
    await fetch(`${baseUrl}/api/jobs/daily-aggregate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-job-secret": jobSecret },
      body: JSON.stringify({ telegramUserId, days: Math.max(14, days) }),
    }).catch(() => null);

    await reply(`✅ Sync sukses.\n${payload}\n\nKetik /aiinsight ${days}d atau /plan 7d`);
    return NextResponse.json({ ok: true });
  }

  if (text.startsWith("/sync")) {
    const m = text.match(/\/sync\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    await reply(`Konfirmasi: aku akan menarik histori aktivitas ${days} hari terakhir.\nBalas: /syncgo ${days}`);
    return NextResponse.json({ ok: true });
  }

  // /insight (basic)
  if (text.startsWith("/insight")) {
    const m = text.match(/\/insight\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    const w = await summarizeLoad(telegramUserId, days);
    if (w.sessions === 0) {
      await reply(`Belum ada data ${days} hari terakhir. Mau tarik histori? /sync ${days}d`);
      return NextResponse.json({ ok: true });
    }

    await reply(
      [
        `📈 Insight ${days} hari (basic)`,
        `Sesi: ${w.sessions}`,
        `Total: ${w.total_km} km | ${w.total_hours} jam | elev ${w.total_elev_m} m`,
        `By type: ${Object.entries(w.by_type)
          .map(([k, v]) => `${k}(${v.sessions})`)
          .join(", ") || "-"}`,
        "",
        "Untuk insight AI: /aiinsight 7d",
      ].join("\n")
    );
    return NextResponse.json({ ok: true });
  }

  // /aiinsight (Groq)
  if (text.startsWith("/aiinsight")) {
    const m = text.match(/\/aiinsight\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    const nowWeek = await summarizeLoad(telegramUserId, 7);
    const prevRows = await sql`
      SELECT COALESCE(SUM(moving_time_s),0)::bigint AS time_s
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
        AND start_date >= NOW() - (14 * INTERVAL '1 day')
        AND start_date < NOW() - (7 * INTERVAL '1 day')
    `;
    const prevHours = Number((prevRows[0] as any).time_s || 0) / 3600;
    const delta = pctChange(nowWeek.total_hours, prevHours);

    const { fatigue, checkins } = await getCheckinSignals(telegramUserId, 7);

    const actRows = await sql`
      SELECT type, name, start_date, distance_m, moving_time_s, elev_gain_m, avg_hr
      FROM activities
      WHERE telegram_user_id = ${telegramUserId}
        AND start_date >= NOW() - (${days}::int * INTERVAL '1 day')
      ORDER BY start_date DESC NULLS LAST
      LIMIT 50
    `;
    if (actRows.length === 0) {
      await reply(`Belum ada data aktivitas ${days} hari terakhir. Coba /sync ${days}d`);
      return NextResponse.json({ ok: true });
    }

    const userRows = await sql`
      SELECT goal_text, goal_date, preferred_sports, training_days_per_week
      FROM users
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;
    const prof = userRows[0] as any;

    const lastActs = (actRows as any[]).slice(0, 7).map((a) => ({
      start_date: a.start_date ? new Date(a.start_date).toISOString() : null,
      name: a.name || null,
      type: a.type || null,
      km: Number((Number(a.distance_m || 0) / 1000).toFixed(2)),
      minutes: Math.round(Number(a.moving_time_s || 0) / 60),
      elev_m: Number(a.elev_gain_m ?? 0),
      avg_hr: a.avg_hr != null ? Number(a.avg_hr) : null,
    }));

    const payload = {
      days,
      summary: {
        sessions: nowWeek.sessions,
        total_km: nowWeek.total_km,
        total_hours: nowWeek.total_hours,
        total_elev_m: nowWeek.total_elev_m,
        by_type: nowWeek.by_type,
        last_7_activities: lastActs,
        checkins_last_days: (checkins as any[]).map((c) => ({
          day: String(c.day),
          sleep_hours: c.sleep_hours != null ? Number(c.sleep_hours) : null,
          soreness: c.soreness != null ? Number(c.soreness) : null,
          mood: c.mood != null ? Number(c.mood) : null,
          note: null,
        })),
        trend: {
          prev_week_hours: Number(prevHours.toFixed(1)),
          curr_week_hours: nowWeek.total_hours,
          week_over_week_change_pct: delta == null ? null : Number((delta * 100).toFixed(0)),
        },
        fatigue_index: fatigue,
        profile: {
          goal_text: prof?.goal_text || null,
          goal_date: prof?.goal_date ? String(prof.goal_date).slice(0, 10) : null,
          preferred_sports: prof?.preferred_sports || null,
          training_days_per_week: prof?.training_days_per_week ?? null,
        },
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

  // /plan 7d (weekly plan generator)
  if (text.startsWith("/plan")) {
    const m = text.match(/\/plan\s+(\d+)\s*d?/i);
    const days = m ? Number(m[1]) : 7;

    // reuse aiinsight payload but ask for plan
    const userRows = await sql`
      SELECT goal_text, goal_date, preferred_sports, training_days_per_week
      FROM users
      WHERE telegram_user_id = ${telegramUserId}
      LIMIT 1
    `;
    const prof = userRows[0] as any;

    const w = await summarizeLoad(telegramUserId, 7);
    const { fatigue, checkins } = await getCheckinSignals(telegramUserId, 7);

    if (w.sessions === 0) {
      await reply("Belum ada data. Tarik dulu: /sync 7d lalu /plan 7d");
      return NextResponse.json({ ok: true });
    }

    const payload = {
      days,
      summary: {
        sessions: w.sessions,
        total_km: w.total_km,
        total_hours: w.total_hours,
        total_elev_m: w.total_elev_m,
        by_type: w.by_type,
        last_7_activities: [],
        checkins_last_days: (checkins as any[]).map((c) => ({
          day: String(c.day),
          sleep_hours: c.sleep_hours != null ? Number(c.sleep_hours) : null,
          soreness: c.soreness != null ? Number(c.soreness) : null,
          mood: c.mood != null ? Number(c.mood) : null,
          note: null,
        })),
        fatigue_index: fatigue,
        profile: {
          goal_text: prof?.goal_text || null,
          goal_date: prof?.goal_date ? String(prof.goal_date).slice(0, 10) : null,
          preferred_sports: prof?.preferred_sports || null,
          training_days_per_week: prof?.training_days_per_week ?? null,
        },
        request: "Generate a 7-day plan. Mix endurance + strength. Include intensity guidance and rest/recovery days. Output Indonesian.",
      },
    };

    try {
      await reply("🗓️ Membuat weekly plan (AI)...");
      const aiText = await generateAiInsight(payload as any);
      await reply(`🗓️ Weekly Plan ${days} hari\n\n${aiText}`);
    } catch (e: any) {
      await reply(`Plan gagal: ${e?.message || String(e)}`);
    }

    return NextResponse.json({ ok: true });
  }

  // /checkin
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

  await reply("Perintah tersedia: /connect, /sync, /insight, /aiinsight, /plan, /profile, /setgoal, /setpref, /autocoach, /checkin");
  return NextResponse.json({ ok: true });
}
