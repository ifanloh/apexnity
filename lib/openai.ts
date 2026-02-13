export type AiInsightInput = {
  days: number;
  summary: {
    sessions: number;
    total_km: number;
    total_hours: number;
    total_elev_m: number;
    by_type: Record<string, { sessions: number; km: number; hours: number; elev_m: number }>;
    last_7_activities: Array<{
      start_date: string | null;
      name: string | null;
      type: string | null;
      km: number;
      minutes: number;
      elev_m: number;
      avg_hr: number | null;
    }>;
    checkins_last_days: Array<{
      day: string;
      sleep_hours: number | null;
      soreness: number | null;
      mood: number | null;
      note: string | null;
    }>;
  };
};

export async function generateAiInsight(input: AiInsightInput): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = [
    "Kamu adalah pelatih endurance + strength (trail/cycling/strength).",
    "Berikan analisis singkat, konkret, dan bisa langsung dilakukan.",
    "Gunakan data yang diberikan saja. Jika ada yang kurang, sebutkan asumsi dengan singkat.",
    "Output wajib Bahasa Indonesia.",
    "Format output:",
    "1) Ringkasan kondisi (3-5 kalimat)",
    "2) Temuan utama (bullet 3-5)",
    "3) Rekomendasi 3 hari ke depan (Day 1/Day 2/Day 3)",
    "4) Recovery checklist (bullet 3-6)",
  ].join("\n");

  const payload = {
    days: input.days,
    data: input.summary,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      max_output_tokens: 500,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }

  const json: any = await res.json();
  const text =
    json?.output_text ||
    json?.output?.[0]?.content?.map((c: any) => c?.text).filter(Boolean).join("\n") ||
    "";

  return String(text || "").trim() || "AI tidak mengembalikan teks.";
}
