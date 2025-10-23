// api/typeform-quiz.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // === Env
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET; // valfritt – ej strikt verifiering här
  const KLAVIYO_METRIC = process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  // Valfri debug, bra vid felsökning (syns i Vercel Logs)
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  try {
    // === Body från Typeform
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // === E-post (från Email-fråga eller hidden.email)
    const email =
      (fr.answers || []).find((a) => a?.type === "email")?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email found, skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email in submission; skipping." });
    }

    // === Quiz-properties
    const ending =
      fr?.calculated?.outcome?.title ||
      fr?.hidden?.ending ||
      "unknown";

    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // Svara Typeform direkt (så de inte väntar på Klaviyo)
    res.status(200).json({ ok: true });

    // === Hjälpare: POST till Klaviyo med retry + timeout
    async function postToKlaviyoWithRetry(eventBody) {
      const url = "https://a.klaviyo.com/api/events/";
      const maxRetries = 4;
      const timeoutMs = 30000; // 30s

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
              revision: "2023-07-15",
            },
            body: JSON.stringify(eventBody),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (resp.ok) {
            console.log(`Klaviyo OK on attempt ${attempt} for`, email, ending);
            return resp;
          } else {
            const text = await resp.text().catch(() => "");
            console.warn(
              `Klaviyo responded ${resp.status} on attempt ${attempt}: ${text}`
            );
          }
        } catch (err) {
          console.error(`Klaviyo fetch error attempt ${attempt}:`, err?.message || err);
          if (attempt === maxRetries) throw err;
          // Exponential backoff: 2s, 4s, 8s, 8s (cap vid 8s)
          await new Promise((r) =>
            setTimeout(r, Math.min(8000, 2000 * 2 ** (attempt - 1)))
          );
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    // === Bygg event + skicka i bakgrunden
    queueMicrotask(async () => {
      try {
        if (!KLAVIYO_API_KEY) throw new Error("Missing KLAVIYO_API_KEY");

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

        await postToKlaviyoWithRetry(eventBody);
      } catch (err) {
        console.error("Background error:", err);
      }
    });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
