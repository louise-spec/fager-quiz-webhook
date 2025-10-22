// api/typeform-quiz.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";
  const KLAVIYO_METRIC = process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch (e) {
    console.error("JSON parse error:", e);
    return res.status(200).json({ ok: false, note: "Bad JSON" });
  }

  const fr = body?.form_response || {};
  const email =
    (fr.answers || []).find(a => a?.type === "email" && a?.email)?.email ||
    fr.hidden?.email || null;

  const ending = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
  const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
  const source = fr?.hidden?.source || "Website";
  const submittedAt = fr?.submitted_at || new Date().toISOString();

  // Svara 200 direkt så Typeform aldrig ser 500
  res.status(200).json({ ok: true });

  // Skicka till Klaviyo i bakgrunden
  queueMicrotask(async () => {
    try {
      if (!KLAVIYO_API_KEY) throw new Error("Missing KLAVIYO_API_KEY");
      if (!email) {
        console.warn("No email found; skipping Klaviyo.");
        return;
      }

      const eventBody = {
        data: {
          type: "event",
          attributes: {
            metric: { name: KLAVIYO_METRIC },
            properties: {
              quiz_name: quizName,
              quiz_result: ending,
              source,
              submitted_at: submittedAt,
            },
            profile: { email },
            occurred_at: submittedAt,
          },
        },
      };

      const r = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          Accept: "application/json",
          revision: "2023-07-15",
        },
        body: JSON.stringify(eventBody),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        console.error("Klaviyo error", r.status, t);
      } else {
        console.log("Klaviyo OK for", email, ending);
      }
    } catch (err) {
      console.error("Background error:", err);
    }
  });
}
