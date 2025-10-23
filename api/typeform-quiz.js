// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC = process.env.KLAVIYO_METRIC || "Filled Out Form"; // <- namn
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  // Hjälpsam maskerad logg
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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // (Valfritt) enkel secret-kontroll
    if (TYPEFORM_SECRET) {
      const sentSecret =
        body?.secret ||
        body?.form_response?.hidden?.secret ||
        body?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // E-post
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Quiz-data
    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();
    const formId = fr?.form_id || null;

    // Event enligt “bredast kompatibla” modellen:
    // - metric: i attributes.metric (namn)
    // - profile: som relationship (med id=$email:<email>)
    // - time: ISO8601
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          metric: { name: KLAVIYO_METRIC }, // <- namn, inte relationship
          properties: {
            quiz_name: quizName,
            quiz_result: ending,
            source,
            submitted_at: submittedAt,
            ...(formId ? { formId } : {}),
          },
          profile: { email },  // vissa miljöer accepterar även denna i attributes
          time: submittedAt,
        },
        relationships: {
          profile: {
            data: { type: "profile", id: `$email:${email}` },
          },
        },
      },
    };

    // Skicka till Klaviyo (utan revision-header)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      console.log("Posting to Klaviyo…");
      const resp = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        },
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("Klaviyo error:", resp.status, txt?.slice(0, 700));
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
