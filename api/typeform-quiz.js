// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // --- Env
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET; // (ej använd här, men kvar om ni vill verifiera senare)
  const KLAVIYO_METRIC =
    process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  // Maskerad nyckel i loggen så vi vet vilken som används
  console.log(
    "Key check:",
    (process.env.KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (process.env.KLAVIYO_API_KEY || "").slice(-4)
  );
  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
  }

  try {
    // --- Läs body (Typeform skickar JSON)
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // --- Hämta e-post
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      // Svara 200 så Typeform inte spammar retries
      console.warn("No email found, skipping Klaviyo send.");
      return res
        .status(200)
        .json({ ok: true, note: "No email in submission; skipping." });
    }

    // --- Hämta quiz-data
    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // --- Event enligt Klaviyo v2023-07-15:
    // attributes: { properties, time }
    // relationships: { metric, profile }
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name: quizName,
            quiz_result: ending,
            source,
            submitted_at: submittedAt,
          },
          time: submittedAt, // <-- korrekt fält för tid
        },
        relationships: {
          metric: {
            data: {
              type: "metric",
              // Om metriskt namn inte finns kommer Klaviyo skapa det.
              attributes: { name: KLAVIYO_METRIC },
            },
          },
          profile: {
            data: {
              type: "profile",
              attributes: { email },
            },
          },
        },
      },
    };

    try {
      console.log("Posting to Klaviyo…");
      await postToKlaviyoWithRetry(eventBody, KLAVIYO_API_KEY);
      console.log("Klaviyo OK for", email, ending);
    } catch (err) {
      console.error("Klaviyo error:", err?.message || err);
      // vi svarar ändå 200 till Typeform
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Postar event till Klaviyo med kort timeout och 1 retry.
 * Vi väntar in svaret innan vi returnerar till Typeform.
 */
async function postToKlaviyoWithRetry(eventBody, apiKey) {
  const url = "https://a.klaviyo.com/api/events/";
  const maxRetries = 1; // 1 retry (= 2 försök totalt)
  const timeoutMs = 5000; // 5s timeout per försök

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: "2023-07-15",
        },
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${txt?.slice(0, 300)}`);
      }

      return; // success
    } catch (err) {
      clearTimeout(timer);
      console.error(
        `Klaviyo fetch error attempt ${attempt}:`,
        err?.message || err
      );
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500)); // liten backoff
    }
  }
}
