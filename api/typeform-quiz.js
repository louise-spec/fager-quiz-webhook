// api/typeform-quiz.js
// Endpoint som mappar endings → ending_key och skickar Klaviyo-event

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";
  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  // 1) Synonym-karta för endings → ending_key
  //    Lägg till alla dina kända endings här (vänster sida kan vara olika stavningar)
  const ENDING_LOOKUP = {
    // Exempel
    "john linus": "john_linus",
    "johnlinus": "john_linus",
    "john-linus": "john_linus",
    "bett a": "bett_a",
    "bett-a": "bett_a",
    "bett b": "bett_b",
    "bett-b": "bett_b",
    // ... fyll på alla era varianter här
  };

  // 2) slugifier – fallback för okända endings → gör en stabil key
  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown";

  // 3) normalisera ending via lookup + slugify
  const toEndingKey = (title) => {
    const raw = String(title || "").trim();
    if (!raw) return "unknown";
    const compact = raw.toLowerCase().replace(/\s+/g, " ").replace(/-/g, "-");
    if (ENDING_LOOKUP[compact]) return ENDING_LOOKUP[compact];
    // pröva utan mellanslag/streck
    const simplified = compact.replace(/[\s-]+/g, "");
    if (ENDING_LOOKUP[simplified]) return ENDING_LOOKUP[simplified];
    return slugify(raw);
  };

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // (valfritt) enkel secret-check
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret || body?.form_response?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // Email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.", {
        form_id: fr?.form_id,
        token: fr?.token,
      });
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Läs ending från calculated outcome → annars hidden.ending
    const endingTitle =
      fr?.calculated?.outcome?.title ||
      fr?.hidden?.ending ||
      "Unknown";

    const ending_key = toEndingKey(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // Klaviyo Events API (nya JSON:API – OBS: metric/profile i attributes)
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          metric: { name: "Fager Quiz Completed" }, // byt om du vill
          profile: { email },
          properties: {
            quiz_name,
            ending_key,           // ← använd denna för flödeslogiken
            ending_title: endingTitle,
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token,
          },
          time: submittedAt,
        },
      },
    };

    // Skicka
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const resp = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          revision: "2024-06-15", // giltigt datumformat
        },
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("Klaviyo error:", resp.status, txt?.slice(0, 1200));
        return res.status(502).json({ ok: false, status: resp.status, error: txt });
      }

      const data = await resp.json().catch(() => ({}));
      console.log("✅ Klaviyo OK", { email, ending_key, endingTitle });
      return res.status(200).json({ ok: true, klaviyo: data });
    } catch (err) {
      clearTimeout(timeout);
      console.error("Klaviyo fetch error:", err?.message || err);
      return res.status(502).json({ ok: false, error: String(err?.message || err) });
    }
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
