import { sql } from "@/lib/db";

export type UserStateRow = {
  state: string | null;
  data: any;
};

export async function setState(userId: number, state: string, data: any = {}) {
  await sql`
    INSERT INTO user_state (user_id, state, data, updated_at)
    VALUES (${userId}, ${state}, ${data}, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
}

export async function getState(userId: number): Promise<UserStateRow | null> {
  const rows = await sql<
    { state: string | null; data: any }[]
  >`
    SELECT state, data
    FROM user_state
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    state: row.state ?? null,
    data: row.data ?? {},
  };
}

export async function clearState(userId: number) {
  await sql`
    DELETE FROM user_state
    WHERE user_id = ${userId}
  `;
}
