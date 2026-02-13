export async function qstashPublish(destinationUrl: string, body: unknown) {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return false;

  const publishUrl = `https://qstash.upstash.io/v2/publish/${destinationUrl}`;
  const internalSecret = process.env.INTERNAL_JOB_SECRET || "";

  const res = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Forward-X-Internal-Secret": internalSecret,
    },
    body: JSON.stringify(body),
  });

  return res.ok;
}
