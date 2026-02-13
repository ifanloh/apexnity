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
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const system = [
    "Kamu adalah pelatih endurance + strength (trail/cycling/strength).",
    "Berikan analisis singkat, konkret, dan bisa langsung dilakukan.",
    "Gunakan data yang diberikan saja. Jika ada yang kurang, sebutkan asumsi singkat.",
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

  // Groq OpenAI-compatible Chat Completions endpoint
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.4,
      max_tokens: 550,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq error: ${res.status} ${t}`);
  }

  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content || "";
  return String(text || "").trim() || "AI tidak mengembalikan teks.";
}

export async function generateCoachReply(payload: any) {
  const systemPrompt = `
Kamu adalah AI endurance coach pribadi.
Jawab seperti pelatih yang adaptif dan kontekstual.
Jangan pakai format laporan kecuali diminta.
Jawaban singkat, personal, dan actionable.
`;

  const userPrompt = `
DATA ATLET:
${JSON.stringify(payload.summary, null, 2)}

PERTANYAAN USER:
${payload.summary.coach_chat.user_message}

Jawab langsung sesuai pertanyaan user.
Jangan ulangi data kecuali relevan.
`;

  // panggil Groq seperti biasa
}
