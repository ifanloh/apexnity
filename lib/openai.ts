// lib/openai.ts
// Groq OpenAI-compatible client + 2 modes:
// - generateAiInsight(): laporan (format tetap)
// - generateCoachReply(): chat bebas (tanpa template laporan)

export type AiInput = {
  days: number;
  summary: any; // payload dari buildCoachPayload()
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function groqChat(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKey = mustEnv("GROQ_API_KEY");
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 650,
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

// =========================
// MODE 1: INSIGHT (LAPORAN)
// =========================
export async function generateAiInsight(input: AiInput): Promise<string> {
  const system = [
    "Kamu adalah pelatih endurance + strength (trail/cycling/strength).",
    "Gunakan data yang diberikan saja. Jika ada yang kurang, tulis asumsi singkat.",
    "Output wajib Bahasa Indonesia.",
    "",
    "WAJIB pakai format tetap ini:",
    "1) Ringkasan kondisi (3-5 kalimat)",
    "2) Temuan utama (bullet 3-5)",
    "3) Rekomendasi 3 hari ke depan (Day 1/Day 2/Day 3)",
    "4) Recovery checklist (bullet 3-6)",
  ].join("\n");

  const user = JSON.stringify(
    {
      mode: "INSIGHT_REPORT",
      days: input.days,
      data: input.summary,
    },
    null,
    2
  );

  return groqChat({ system, user, temperature: 0.35, maxTokens: 700 });
}

// =========================
// MODE 2: COACH CHAT (BEBAS)
// =========================
export async function generateCoachReply(input: AiInput): Promise<string> {
  const system = [
    "Kamu adalah AI coach pribadi untuk trail/cycling/strength.",
    "INI MODE CHAT (konsultasi bebas).",
    "Jawab LANGSUNG sesuai pertanyaan user. Jangan pakai template laporan 1)-4) kecuali user minta.",
    "Nada: natural, seperti coach di DM. Ringkas, spesifik, actionable.",
    "Boleh tanya balik maksimal 1 pertanyaan klarifikasi kalau memang perlu.",
    "Jika user minta rencana latihan: beri saran latihan hari ini + besok, lengkap durasi dan intensitas (easy/Z2/tempo/interval) + opsi alternatif.",
    "Jika ada red flags (nyeri tajam, bengkak berat, kebas/kesemutan, pusing, nyeri dada): sarankan stop dan konsultasi profesional.",
    "Output Bahasa Indonesia.",
  ].join("\n");

  const userMessage = String(input?.summary?.coach_chat?.user_message || "").trim();

  // ringkas konteks biar chat tidak berubah jadi laporan
  const context = {
    trend: input?.summary?.trend ?? null,
    fatigue_index: input?.summary?.fatigue_index ?? null,
    profile: input?.summary?.profile ?? null,
    last_activities: input?.summary?.last_7_activities ?? [],
    checkins: input?.summary?.checkins_last_days ?? [],
    recent_chat: input?.summary?.coach_chat?.recent_chat ?? [],
  };

  const user = [
    "KONTEKS (gunakan seperlunya, jangan diulang semua):",
    JSON.stringify(context, null, 2),
    "",
    "PERTANYAAN USER:",
    userMessage || "(user mengirim pesan kosong)",
    "",
    "Instruksi: Jawab hanya yang relevan dengan pertanyaan. Jangan membuat ringkasan mingguan kecuali diminta.",
  ].join("\n");

  // Temperature sedikit lebih tinggi supaya tidak template
  return groqChat({ system, user, temperature: 0.7, maxTokens: 500 });
}

