// /api/typeform-quiz.js
// Fager Quiz → Klaviyo Events API (Create Event)
// Uses metric-by-name with the correct nested schema under attributes.metric/profile
// and a modern revision. Skips Typeform test payloads and always 200s to Typeform.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  // === Helpers ===
  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown";

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // Typeform "Send test request" uses 'hidden_value'
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    // Optional secret check
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    if (isTypeformTest) {
      console.log("🧪 Typeform test payload – skipping Klaviyo");
      return res.status(200).json({ ok: true, note: "Typeform test – skipped Klaviyo" });
    }

    // Extract email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Quiz fields
    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = slugify(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending detected:", endingTitle, "→", ending_key);

    // === Klaviyo Create Event payload (correct nested schema) ===
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name,
            ending_key,
            ending_title: endingTitle,
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token
          },
          time: submittedAt,
          metric: {
            data: {
              type: "metric",
              attributes: { name: KLAVIYO_METRIC_NAME }
            }
          },
          profile: {
            data: {
              type: "profile",
              attributes: { email }
            }
          }
          // Optionally add a unique_id to prevent dedupe if sending multiple events at the same second:
          // unique_id: fr?.token || crypto.randomUUID(),
        }
      }
    };

    console.log("📤 Posting to Klaviyo (revision=2024-07-15, metric name:", KLAVIYO_METRIC_NAME, ")");

    const resp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-07-15" // modern Events API revision that supports nested metric/profile under attributes
      },
      body: JSON.stringify(eventBody)
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("❌ Klaviyo error:", resp.status, txt?.slice(0, 1200));
      // Still return 200 to keep Typeform green
      return res.status(200).json({ ok: false, upstream: "klaviyo", status: resp.status });
    }

    console.log("✅ Klaviyo OK", { email, ending_key, metric_name: KLAVIYO_METRIC_NAME });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
