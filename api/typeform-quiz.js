// api/typeform-quiz.js
// Version för Fager Quiz → Klaviyo metric ID: VqXtMg
// Robust mot nya endings (slugify-fallback + logging)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // === Environment variables ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC_ID = process.env.KLAVIYO_METRIC_ID || "VqXtMg"; // ert metric-ID
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  // === Known endings (lägg till de ni vill ha egna flöden för) ===
  const ENDING_LOOKUP = {
    "john linus": "john_linus",
    "johnlinus": "john_linus",
    "john-linus": "john_linus",
    "bett a": "bett_a",
    "bett-a": "bett_a",
    "bett b": "bett_b",
    "bett-b": "bett_b",
  };

  // === Helper: slugify for unknown endings ===
  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown";

  // === Map ending to key ===
  const toEndingKey = (title) => {
    const raw = String(title || "").trim();
    if (!raw) return "unknown";
    const lower = raw.toLowerCase();
    return (
      ENDING_LOOKUP[lower] ||
      ENDING_LOOKUP[lower.replace(/[\s-]+/g, "")] ||
      slugify(raw)
    );
  };

  // === Set to avoid duplicate "unknown ending" logs ===
  const SEEN_UNKNOWN = new Set();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // === (Optional) Typeform secret validation ===
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // === Extract email ===
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // === Extract ending info ===
    const endingTitle =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = toEndingKey(endingTitle);

    // Log new / unmapped endings once
    if (
      !Object.values(ENDING_LOOKUP).includes(ending_key) &&
      !ENDING_LOOKUP[endingTitle.toLowerCase()]
    ) {
      const k = `${endingTitle} -> ${ending_key}`;
      if (!SEEN_UNKNOWN.has(k)) {
        SEEN_UNKNOWN.add(k);
        console.warn("💡 Ny/omappad ending upptäckt:", k);
        console.warn(`  Lägg till i ENDING_LOOKUP vid behov:`);
        console.warn(`  "${endingTitle.toLowerCase()}": "${ending_key}",`);
        console.warn(`  "${endingTitle.toLowerCase().replace(/[\s-]+/g, "")}": "${ending_key}",`);
      }
    }

    // === Hidden fields ===
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // === Build event for Klaviyo ===
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name,
            ending_key, // används i Klaviyo-flöden
            ending_title: endingTitle,
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token,
          },
          occurred_at: submittedAt,
        },
        relationships: {
          metric: { data: { type: "metric", id: KLAVIYO_METRIC_ID } },
          profile: { data: { type: "profile", id: `$email:${email}` } },
        },
      },
    };

    // === Send to Klaviyo ===
    const resp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-10-15", // krävs för relationship-schemat
      },
      body: JSON.stringify(eventBody),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("❌ Klaviyo error:", resp.status, txt?.slice(0, 1000));
      return res.status(502).json({ ok: false, status: resp.status, error: txt });
    }

    console.log("✅ Klaviyo OK", { email, ending_key, metric: KLAVIYO_METRIC_ID });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
