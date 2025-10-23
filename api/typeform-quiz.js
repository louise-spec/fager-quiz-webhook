// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Env
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC =
    process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET; // valfri validering

  // Hjälpsam debug i Vercel Logs (maskerad)
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    // Typeform skickar JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // (Valfritt) enkel secret-kontroll om du satte en Secret i Typeform/Webhook
    if (TYPEFORM_SECRET) {
      const sentSecret =
        body?.secret || body?.form_response?.hidden?.secret || body?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // Plocka e-post
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      // Svara 200 så Typeform inte spammar retries
      return res
        .status(200)
        .json({ ok: true, note: "No email in submission; skipping." });
    }

    // Quizdata
    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // Bygg eventet – Klaviyo skapar metricen automatiskt om den saknas
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

    // --- Skicka till Klaviyo med korrekt headers (inkl. revision)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000); // 7s timeout

    try {
      console.log("Posting to Klaviyo…");

      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Klaviyo-API-Key ${KLAVIYO_API_KEY}`);
      headers.set("revision", "2024-10-15"); // VIKTIGT: YYYY-MM-DD

      const resp = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers,
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("Klaviyo error:", resp.status, txt?.slice(0, 500));
      } else {
        console.log("Klaviyo OK for", email, ending);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("Klaviyo fetch error:", err?.message || err);
    }

    // Svara alltid 200 till Typeform
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
