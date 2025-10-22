export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const klaviyoKey = process.env.KLAVIYO_API_KEY;
  const secret = process.env.TYPEFORM_SECRET;
  const metric = process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const fr = body?.form_response || {};

  const email =
    (fr.answers || []).find(a => a?.type === "email" && a?.email)?.email ||
    fr.hidden?.email ||
    null;

  if (!email) {
    return res.status(200).json({ ok: true, note: "No email in submission; skipping." });
  }

  const ending = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
  const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
  const source = fr?.hidden?.source || "Website";
  const submittedAt = fr?.submitted_at || new Date().toISOString();

  const eventBody = {
    data: {
      type: "event",
      attributes: {
        metric: { name: metric },
        properties: {
          quiz_name: quizName,
          quiz_result: ending,
          source,
          submitted_at: submittedAt
        },
        profile: { email },
        occurred_at: submittedAt
      }
    }
  };

  const resp = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Klaviyo-API-Key ${klaviyoKey}`,
      revision: "2023-07-15"
    },
    body: JSON.stringify(eventBody)
  });

  const ok = resp.ok;
  return res.status(ok ? 200 : 500).json({ ok });
}
