export const metadata = {
  title: "AI Pro Trainer Bot",
  description: "Strava + Telegram DM report",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
