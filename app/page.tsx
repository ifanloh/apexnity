export const runtime = "nodejs";

type Dashboard = {
  ok: boolean;
  profile: any;
  stravaConnected: boolean;
  lastActivity: any;
  summary7d: any;
  fatigueIndex: number;
  checkins7d: any[];
  now: string;
};

async function getDashboard(): Promise<Dashboard> {
  const base = process.env.APP_BASE_URL || "";
  const res = await fetch(`${base}/api/dashboard`, { cache: "no-store" });
  return res.json();
}

function fmtDate(d?: string) {
  if (!d) return "-";
  return String(d).slice(0, 10);
}

export default async function Home() {
  const data = await getDashboard();

  if (!data.ok) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>AI Pro Trainer Bot</h1>
        <p>Dashboard error.</p>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </main>
    );
  }

  const p = data.profile || {};
  const s = data.summary7d || {};
  const la = data.lastActivity || null;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>AI Pro Trainer Bot</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Status: <b>OK</b> • Updated: {fmtDate(data.now)}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Profile</h2>
          <div>Goal: <b>{p.goal_text || "-"}</b></div>
          <div>Goal date: <b>{p.goal_date ? String(p.goal_date).slice(0, 10) : "-"}</b></div>
          <div>Preferred sports: <b>{p.preferred_sports || "-"}</b></div>
          <div>Training days/week: <b>{p.training_days_per_week ?? "-"}</b></div>
          <div>Auto coach: <b>{p.auto_coach_enabled === false ? "OFF" : "ON"}</b></div>
        </section>

        <section style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Connections</h2>
          <div>Strava: <b>{data.stravaConnected ? "Connected ✅" : "Not connected ❌"}</b></div>
          <div style={{ marginTop: 8 }}>Fatigue Index (7d): <b>{data.fatigueIndex ?? "-"}</b></div>

          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href="https://t.me/" style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 10, textDecoration: "none" }}>
              Open Telegram
            </a>
            <a href="/api/health" style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 10, textDecoration: "none" }}>
              Health Check
            </a>
          </div>
          <p style={{ color: "#777", marginBottom: 0, marginTop: 10 }}>
            Sync/insight dilakukan via command di Telegram: <b>/sync 7d</b>, <b>/aiinsight 7d</b>.
          </p>
        </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>7-day Summary</h2>
          <div>Sesi: <b>{s.sessions ?? 0}</b></div>
          <div>Total: <b>{s.total_km ?? 0} km</b> • <b>{s.total_hours ?? 0} jam</b> • Elev <b>{s.total_elev_m ?? 0} m</b></div>
          <div style={{ marginTop: 8 }}>
            By type:{" "}
            <b>
              {s.by_type
                ? Object.entries(s.by_type).map(([k, v]: any) => `${k}(${v.sessions})`).join(", ")
                : "-"}
            </b>
          </div>
        </section>

        <section style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Last Activity</h2>
          {la ? (
            <>
              <div>Nama: <b>{la.name || "-"}</b></div>
              <div>Tipe: <b>{la.type || "-"}</b></div>
              <div>Jarak: <b>{((la.distance_m || 0) / 1000).toFixed(2)} km</b></div>
              <div>Durasi: <b>{Math.round((la.moving_time_s || 0) / 60)} min</b></div>
              <div>Elev: <b>{la.elev_gain_m ?? 0} m</b></div>
              <div>Tanggal: <b>{la.start_date ? String(la.start_date).slice(0, 10) : "-"}</b></div>
            </>
          ) : (
            <p style={{ color: "#777" }}>Belum ada aktivitas. Tarik histori via Telegram: <b>/sync 7d</b></p>
          )}
        </section>
      </div>

      <section style={{ border: "1px solid #eee", borderRadius: 12, padding: 16, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Check-ins (7d)</h2>
        {Array.isArray(data.checkins7d) && data.checkins7d.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
            {data.checkins7d.map((c: any, idx: number) => (
              <div key={idx} style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: "#666" }}>{String(c.day).slice(0, 10)}</div>
                <div>Sleep: <b>{c.sleep_hours ?? "-"}</b></div>
                <div>Sore: <b>{c.soreness ?? "-"}</b></div>
                <div>Mood: <b>{c.mood ?? "-"}</b></div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "#777" }}>Belum ada check-in. Isi via Telegram: <b>/checkin sleep=7 soreness=2 mood=4 note=ok</b></p>
        )}
      </section>
      <div>
  Strava: <b>{data.stravaConnected ? "Connected ✅" : "Not connected ❌"}</b>
  {data.stravaConnected && data.stravaInfo?.athlete_id ? (
    <span style={{ color: "#666" }}> (athlete_id: {data.stravaInfo.athlete_id})</span>
  ) : null}
</div>
    </main>
  );
}
