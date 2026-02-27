CREATE TABLE user_state (
  user_id BIGINT PRIMARY KEY,
  state TEXT,
  data JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);
import { sql } from "@/lib/db";

export async function setState(userId: number, state: string, data?: any) {
  await sql`
    INSERT INTO user_state (user_id, state, data)
    VALUES (${userId}, ${state}, ${data || {}})
    ON CONFLICT (user_id)
    DO UPDATE SET state = ${state}, data = ${data || {}}, updated_at = NOW()
  `;
}

export async function getState(userId: number) {
  const rows = await sql`
    SELECT state, data FROM user_state WHERE user_id = ${userId}
  `;
  return rows[0] || null;
}

export async function clearState(userId: number) {
  await sql`
    DELETE FROM user_state WHERE user_id = ${userId}
  `;
}
