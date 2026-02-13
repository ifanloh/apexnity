import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { exchangeCodeForToken } from "@/lib/strava";
import { sendTelegramMessage } from "@/lib/telegram";
import { qstashPublish } from "@/lib/qstash";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "Missing code/state" }, { status: 400 });

  const s = await sql`SELECT telegram_user_id FROM oauth_states WHERE state = ${state} LIMIT 1`;
  if (s.length === 0) return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  const telegramUserId = Number((s[0] as any).telegram_user_id);

  const token = await exchangeCodeForToken(code);
  const athleteId = token.athlete.id;

  await sql`
    INSERT INTO strava_accounts (athlete_id, telegram_user_id, access_token, refresh_token, expires_at, scopes)
    VALUES (${athleteId}, ${telegramUserId}, ${token.access_token}, ${token.refresh_token}, ${token.expires_at}, ${token.token_type})
    ON CONFLICT (athlete_id)
    DO UPDATE SET telegram_user_id = EXCLUDED.telegram_user_id,
                  access_token = EXCLUDED.access_token,
                  refresh_token = EXCLUDED.refresh_token,
                  expires_at = EXCLUDED.expires_at,
                  updated_at = NOW()
  `;

  await sql`DELETE FROM oauth_states WHERE state = ${state}`;

  const u = await sql`SELECT telegram_chat_id FROM users WHERE telegram_user_id = ${telegramUserId} LIMIT 1`;
  const chatId = Number((u[0] as any).telegram_chat_id);

  await sendTelegramMessage(chatId, "✅ Strava connected! Report otomatis aktif.");

  const base = process.env.APP_BASE_URL!;
  await qstashPublish(`${base}/api/jobs/initial-sync`, { telegramUserId, athleteId });

  return new NextResponse(
    `<html><body><h3>Connected ✅</h3><p>Balik ke Telegram ya.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
