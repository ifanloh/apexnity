import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sendTelegramMessage } from "@/lib/telegram";
import { createOauthState, buildStravaAuthorizeUrl } from "@/lib/strava";
import { generateAiInsight } from "@/lib/openai"; // isi ini sudah pakai Groq
import { summarizeLoad, getCheckinSignals, pctChange } from "@/lib/training";

export const runtime = "nodejs";

// ====== helpers ======
function isCommand(text: string) {
  return text.startsWith("/");
}

function parseArgs(cmd: string, text: string) {
  return Object.fromEntries(
    text
      .replace(cmd, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((kv: string) => {
        const [k, ...rest] = kv.split("=");
        return [k, rest.join("=")];
      })
  );
}

async function addChatMessage(telegramUserId: number, role: "user" | "assistant", content: string) {
  await sql`
    INSERT INTO chat_messages (telegram_user_id, role, content)
    VALUES (${telegramUserId}, ${role}, ${content})
  `;
}

async function getRecentChat(telegramUserId: number, limit = 10) {
  const rows = await sql`
    SELECT role, content
    FROM chat_messages
    WHERE telegram_user_id = ${telegramUserId}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  // return oldest -> newest
  return (rows as any[]).reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function checkAndIncDailyLimit(telegramUserId: number, maxPerDay = 30) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(today.getUTCDate()).padStart(2, "0");
  const day = `${yyyy}-${mm}-${dd}`;

  const rows = await sql`
    SELECT count
    FROM ai_usage_daily
    WHERE telegram_user_id = ${telegramUserId} AND day = ${day}::date
    LIMIT 1
  `;

  const curr = rows.length ? Number((rows[0] as any).count || 0) : 0;
  if (curr >= maxPerDay) return { ok: false, day, curr, maxPerDay };

  await sql`
    INSERT INTO ai_usage_daily (telegram_user_id, day, count)
    VALUES (${telegramUserId}, ${day}::date, 1)
    ON CONFLICT (telegram_user_id, day)
    DO UPDATE SET count = ai_usage_daily.count + 1
  `;

  return { ok: true, day, curr: curr + 1, maxPerDay };
}

async function buildCoachPayload(telegramUserId: number, userText: string) {
  // load trend (7d vs prev 7d)
  const w7 = await summarizeLoad(telegramUserId, 7);

  const prevRows = await sql`
    SELECT COALESCE(SUM(moving_time_s),0)::bigint AS time_s
    FROM activities
    WHERE telegram_user_id = ${telegramUserId}
      AND start_date >= NOW() - (14 * INTERVAL '1 day')
      AND start_date < NOW() - (7 * INTERVAL '1 day')
  `;
  const prevHours = Number((prevRows[0] as any)?.time_s || 0) / 3600;
  const delta = pctChange(w7.total_hours, prevHours);

  // checkin signals
  const { fatigue, checkins } = await getCheckinSignals(telegramUserId, 7);

  // profile
  const uRows = await sql`
    SELECT goal_text, goal_date, preferred_sports, training_days_per_week
    FROM users
    WHERE telegram_user_id = ${telegramUserId}
    LIMIT 1
  `;
  const prof = uRows[0] as any;

  // last activities
  const actRows = await sql`
    SELECT type, name, start_date, distance_m, moving_time_s, elev_gain_m, avg_hr
    FROM activities
    WHERE telegram_user_id = ${telegramUserId}
    ORDER BY start_date DESC NULLS LAST
    LIMIT 10
  `;

  const lastActs = (actRows as any[]).map((a) => ({
    start_date: a.start_date ? new Date(a.start_date).toISOString() : null,
    name: a.name || null,
    type: a.type || null,
    km: Number((Number(a.distance_m || 0) / 1000).toFixed(2)),
    minutes: Math.round(Number(a.moving_time_s || 0) / 60),
    elev_m: Number(a.elev_gain_m ?? 0),
    avg_hr: a.avg_hr != null ? Number(a.avg_hr) : null,
  }));

  const recentChat = await getRecentChat(telegramUserId, 10);

  // Trick: kita tetap pakai generateAiInsight(), tapi "request" kita ubah jadi mode coach-chat
  return {
    days: 7,
    summary: {
      sessions: w7.sessions,
      total_km: w7.total_km,
      total_hours: w7.total_hours,
      total_elev_m: w7.total_elev_m,
      by_type: w7.by_type,
      last_7_activities: lastActs.slice(0, 7),
      checkins_last_days: (checkins as any[]).map((c) => ({
        day: String(c.day),
        sleep_hours: c.sleep_hours != null ? Number(c.sleep_hours) : null,
        soreness: c.soreness != null ? Number(c.soreness) : null,
        mood: c.mood != null ? Number(c.mood) : null,
        note: null,
      })),
      trend: {
        prev_week_hours: Number(prevHours.toFixed(1)),
        curr_week_hours: w7.total_hours,
        week_over_week_change_pct: delta == null ? null : Number((delta * 100).toFixed(0)),
      },
      fatigue_index: fatigue,
      profile: {
        goal_text: prof?.goal_text || null,
        goal_date: prof?.goal_date ? String(prof.goal_date).slice(0, 10) : null,
        preferred_sports: prof?.preferred_sports || null,
        training_days_per_week: prof?.training_days_per_week ?? null,
      },
      coach_chat: {
        user_message: userText,
        recent_chat: recentChat, // memory pendek (10 pesan)
        instruction:
          "Mode: coach chat. Jawab seperti pelatih: singkat, spesifik, actionable. Jika user tanya rencana latihan, buat saran hari ini + besok. Jika user tanya teknik/alat/cedera ringan, beri saran aman dan sarankan konsultasi profesional bila ada red flags.",
      },
    },
  };
}

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

  // Upsert user
  await sql`
    INSERT INTO users (telegram_user_id, telegram_chat_id)
    VALUES (${telegramUserId}, ${chatId})
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = NOW()
  `;

  const reply = async (t: string) => sendTelegramMessage(chatId, t);

  // =========================
  // COMMANDS (start with "/")
  // =========================
  if (isCommand(text)) {
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
          "/plan 7d                -> weekly plan 7 hari",
          "",
          "Profile:",
          "/profile",
          "/setgoal text=Everesting8850 date=2026-06-01",
          "/setpref sports=trail,cycling,strength days=5",
          "/autocoach on|off",
          "",
          "Check-in:",
          "/checkin sleep=7 soreness=2 mood=4 note=ok",
          "",
          "Chat bebas:",
          "Ketik saja tanpa '/', nanti aku jawab sebagai coach.",
        ].join("\n")
      );
      return NextResponse.json({ ok: true });
    }

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

    if (text.startsWith("/setgoal")) {
      const args = parseArgs("/setgoal", text);
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

    if (text.startsWith("/setpref")) {
      const args = parseArgs("/setpref", text);
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

      await reply(`✅ Sync sukses.\n${payload}\n\nKetik /aiinsight ${days}d atau chat tanya: "saran latihan hari ini?"`);
      return NextResponse.json({ ok: true });
    }

    if (text.startsWith("/sync")) {
      const m = text.match(/\/sync\s+(\d+)\s*d?/i);
      const days = m ? Number(m[1]) : 7;
      await reply(`Konfirmasi: aku akan menarik histori aktivitas ${days} hari terakhir.\nBalas: /syncgo ${days}`);
      return NextResponse.json({ ok: true });
    }

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
          `By type: ${Object.entries(w.by_type).map(([k, v]) => `${k}(${v.sessions})`).join(", ") || "-"}`,
          "",
          "Untuk insight AI: /aiinsight 7d",
        ].join("\n")
      );
      return NextResponse.json({ ok: true });
    }

    if (text.startsWith("/aiinsight")) {
      const m = text.match(/\/aiinsight\s+(\d+)\s*d?/i);
      const days = m ? Number(m[1]) : 7;

      const actRows = await sql`
        SELECT start_date
        FROM activities
        WHERE telegram_user_id = ${telegramUserId}
        ORDER BY start_date DESC NULLS LAST
        LIMIT 1
      `;
      if (actRows.length === 0) {
        await reply(`Belum ada data aktivitas. Tarik dulu: /sync ${days}d`);
        return NextResponse.json({ ok: true });
      }

      try {
        await reply(`🤖 AI Insight ${days} hari\n(analisa sedang dibuat...)`);
        const payload = await buildCoachPayload(telegramUserId, "Buatkan insight latihan dari data terbaru.");
        const aiText = await generateAiInsight(payload as any);
        await reply(`🤖 AI Insight ${days} hari\n\n${aiText}`);
      } catch (e: any) {
        await reply(`AI gagal: ${e?.message || String(e)}`);
      }

      return NextResponse.json({ ok: true });
    }

    if (text.startsWith("/plan")) {
      // plan = coach payload with instruction, still via generateAiInsight()
      try {
        await reply("🗓️ Membuat weekly plan (AI)...");
        const payload = await buildCoachPayload(telegramUserId, "Buatkan rencana latihan 7 hari ke depan yang realistis.");
        // tambahkan hint agar model fokus bikin plan
        (payload as any).summary.coach_chat.instruction +=
          "\nTambahkan output 'Weekly Plan 7 hari' dengan Day 1..Day 7, ada intensitas (easy/Z2/tempo/interval), strength split, dan 1-2 rest/recovery day.";
        const aiText = await generateAiInsight(payload as any);
        await reply(`🗓️ Weekly Plan 7 hari\n\n${aiText}`);
      } catch (e: any) {
        await reply(`Plan gagal: ${e?.message || String(e)}`);
      }
      return NextResponse.json({ ok: true });
    }

    if (text.startsWith("/checkin")) {
      const args = parseArgs("/checkin", text);

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

    await reply("Perintah tersedia: /connect, /sync, /report, /insight, /aiinsight, /plan, /profile, /setgoal, /setpref, /autocoach, /checkin");
    return NextResponse.json({ ok: true });
  }

  // =========================
  // AI CHAT (non-command text)
  // =========================
  // 1) rate limit
  const limit = await checkAndIncDailyLimit(telegramUserId, 30);
  if (!limit.ok) {
    await reply(`Limit AI harian tercapai (${limit.curr}/${limit.maxPerDay}). Coba besok ya.`);
    return NextResponse.json({ ok: true });
  }

  // 2) store user message
  await addChatMessage(telegramUserId, "user", text);

  try {
    await reply("🧠 (coach lagi mikir...)");
    const payload = await buildCoachPayload(telegramUserId, text);
    const aiText = await generateAiInsight(payload as any);

    // 3) store assistant message
    await addChatMessage(telegramUserId, "assistant", aiText);

    await reply(aiText);
  } catch (e: any) {
    await reply(`Coach AI gagal: ${e?.message || String(e)}`);
  }

  return NextResponse.json({ ok: true });
}
