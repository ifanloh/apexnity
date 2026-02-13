function secToHms(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}j ${m}m` : `${m}m ${s}d`;
}

export function buildActivityReport(a: {
  name?: string;
  type?: string;
  distance_m?: number;
  moving_time_s?: number;
  elev_gain_m?: number;
  avg_hr?: number | null;
}) {
  const km = (a.distance_m || 0) / 1000;
  const dur = secToHms(a.moving_time_s || 0);
  const elev = a.elev_gain_m ?? 0;

  const type = (a.type || "Workout").toLowerCase();
  let load = 0;

  if (type.includes("run")) load = km * 10 + elev * 0.5;
  else if (type.includes("ride")) load = km * 2 + elev * 0.2;
  else load = 30;

  const advice =
    load >= 250
      ? "Beban tinggi. Prioritaskan recovery, besok lebih aman Z1–Z2 atau strength ringan."
      : load >= 120
      ? "Beban sedang. Besok bisa easy atau strength fokus teknik."
      : "Beban ringan. Besok aman buat sesi kualitas kalau badan enak.";

  const lines = [
    `✅ *Activity Logged*`,
    `*${a.name || "Untitled"}*`,
    `Tipe: ${a.type || "-"}`,
    `Jarak: ${km.toFixed(2)} km`,
    `Durasi: ${dur}`,
    `Elev: ${elev} m`,
    a.avg_hr ? `Avg HR: ${a.avg_hr}` : undefined,
    `Load (est): *${Math.round(load)}*`,
    ``,
    `🧠 *Coach Note:* ${advice}`,
  ].filter(Boolean);

  return lines.join("\n");
}
