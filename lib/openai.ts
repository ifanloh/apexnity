export type AiInsightInput = {
// =========================
// 1) MODE: INSIGHT (laporan)
// =========================
export async function generateAiInsight(input: AiInsightInput): Promise<string> {
  const system = [
    "Kamu adalah pelatih endurance + strength (trail/cycling/strength).",
    "Berikan analisis singkat, konkret, dan bisa langsung dilakukan.",
    "Gunakan data yang diberikan saja. Jika ada yang kurang, sebutkan asumsi singkat.",
    "Output wajib Bahasa Indonesia.",
    "Format output WAJIB:",
    "1) Ringkasan kondisi (3-5 kalimat)",
    "2) Temuan utama (bullet 3-5)",
    "3) Rekomendasi 3 hari ke depan (Day 1/Day 2/Day 3)",
    "4) Recovery checklist (bullet 3-6)",
  ].join("\n");

  const payload = { days: input.days, data: input.summary };
  return groqChat(system, JSON.stringify(payload), { temperature: 0.35, maxTokens: 650 });
}

// =========================
// 2) MODE: COACH CHAT (bebas)
// =========================
export async function generateCoachReply(input: AiInsightInput): Promise<string> {
  const system = [
    "Kamu adalah AI coach pribadi (trail/cycling/strength).",
    "Ini MODE CHAT (konsultasi bebas).",
    "Jawab LANGSUNG sesuai pertanyaan user — jangan pakai template laporan kecuali user minta.",
    "Boleh bertanya balik maksimal 1 pertanyaan klarifikasi kalau perlu.",
    "Gaya: ringkas, spesifik, actionable.",
    "Kalau user tanya latihan hari ini/besok: beri rekomendasi jelas (durasi, intensitas, opsi alternatif).",
    "Kalau ada indikasi cedera serius (nyeri tajam, bengkak, kesemutan, pusing, nyeri dada): sarankan stop dan konsultasi profesional.",
    "Output Bahasa Indonesia.",
  ].join("\n");

  // input.summary.coach_chat berisi user_message + recent_chat
  const userMessage = input?.summary?.coach_chat?.user_message || "";
  const recent = input?.summary?.coach_chat?.recent_chat || [];

  // Kita gabungkan memory pendek supaya jawaban tidak terasa sama
  const memoryText = Array.isArray(recent) && recent.length
    ? recent
        .map((m: any) => `${m.role === "assistant" ? "Coach" : "User"}: ${String(m.content || "")}`)
        .join("\n")
    : "";

  const user = [
    "KONTEKS ATLET (ringkas, gunakan seperlunya):",
    JSON.stringify(
      {
        trend: input?.summary?.trend,
        fatigue_index: input?.summary?.fatigue_index,
        profile: input?.summary?.profile,
        last_activities: input?.summary?.last_7_activities,
        checkins: input?.summary?.checkins_last_days,
      },
      null,
      2
    ),
    "",
    memoryText ? "RIWAYAT CHAT TERAKHIR:" : "",
    memoryText || "",
    "",
    "PERTANYAAN USER:",
    userMessage,
    "",
    "Instruksi: Jawab sesuai pertanyaan user. Jangan mengulang angka-angka kecuali relevan. Jangan pakai format 1)-4) kecuali diminta.",
  ].join("\n");

  return groqChat(system, user, { temperature: 0.55, maxTokens: 500 });
}
