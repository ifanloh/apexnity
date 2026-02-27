import crypto from "crypto";
import { sql } from "./db";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

type TokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  athlete: { id: number };
};

export async function createOauthState(telegramUserId: number) {
  const state = crypto.randomBytes(24).toString("hex");
  await sql`
    INSERT INTO oauth_states (state, telegram_user_id)
    VALUES (${state}, ${telegramUserId})
  `;
  return state;
}

export function buildStravaAuthorizeUrl(state: string) {
  const clientId = mustEnv("STRAVA_CLIENT_ID");
  const redirectURL = mustEnv("STRAVA_REDIRECT_URL"); // env kamu tetap _URL

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectURL, // ✅ nama parameter WAJIB redirect_uri
    approval_prompt: "auto",
    scope: "read,activity:read_all",
    state,
  });

  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}


export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshStravaToken(refreshToken: string): Promise<TokenResponse> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) throw new Error(`Strava refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function getValidAccessTokenByAthleteId(athleteId: number) {
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at
    FROM strava_accounts
    WHERE athlete_id = ${athleteId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;

  const { access_token, refresh_token, expires_at } = rows[0] as any;
  const now = Math.floor(Date.now() / 1000);

  if (now < Number(expires_at) - 60) return { accessToken: access_token as string };

  const refreshed = await refreshStravaToken(refresh_token as string);
  await sql`
    UPDATE strava_accounts
    SET access_token = ${refreshed.access_token},
        refresh_token = ${refreshed.refresh_token},
        expires_at = ${refreshed.expires_at},
        updated_at = NOW()
    WHERE athlete_id = ${athleteId}
  `;
  return { accessToken: refreshed.access_token };
}
const estimatedRPE = estimateRPEFromHR(
  activity.average_heartrate,
  user.hr_max,
  user.hr_rest
);

const sessionLoad = Math.round(
  (activity.moving_time / 60) * estimatedRPE
);
