// /api/typeform-quiz.js
// Auto-fallback mellan två Klaviyo-scheman:
// A) revision 2024-06-15 + attributes.metric { name }
// B) revision 2024-10-15 + relationships.metric/profile (med metric-ID)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const KLAVIYO_METRIC_ID = process.env.KLAVIYO_METRIC_ID || "VqXtMg"; // för fallback B
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

    // Typeform test?
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    // Secret validering
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

    // Email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Fields
    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = slugify(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // ===== Attempt A: 2024-06-15 + metric by NAME (attributes) =====
    const payloadA = {
      data: {
        type: "event",
        attributes: {
          metric: { name: KLAVIYO_METRIC_NAME },
          profile: { email },
          properties: {
            quiz_name,
            ending_key,
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

    console.log("📤 Klaviyo Attempt A (revision=2024-06-15, metric name:", KLAVIYO_METRIC_NAME, ")");
    let resp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-06-15",
      },
      body: JSON.stringify(payloadA),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      const isRelationshipError =
        txt.includes("'data' key missing in relationship") ||
        txt.includes("'metric' is not an allowed relation") ||
        txt.includes("relationship");

      console.error("❌ Attempt A error:", resp.status, txt.slice(0, 800));

      // ===== Attempt B: 2024-10-15 + relationships (metric/profile by ID) =====
      if (isRelationshipError) {
        const payloadB = {
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

        console.log("🔁 Klaviyo Attempt B (revision=2024-10-15, metric ID:", KLAVIYO_METRIC_ID, ")");
        resp = await fetch("https://a.klaviyo.com/api/events/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
            revision: "2024-10-15",
          },
          body: JSON.stringify(payloadB),
        });

        if (!resp.ok) {
          const txtB = await resp.text().catch(() => "");
          console.error("❌ Attempt B error:", resp.status, txtB.slice(0, 800));
          // ge 200 till Typeform men med info
          return res.status(200).json({
            ok: false,
            upstream: "klaviyo",
            attempt: "B",
            status: resp.status,
          });
        }

        console.log("✅ Klaviyo OK (Attempt B)", { email, ending_key, metric_id: KLAVIYO_METRIC_ID });
        return res.status(200).json({ ok: true, attempt: "B" });
      }

      // Annat fel än relationsschema → returnera 200 men loggat
      return res.status(200).json({ ok: false, upstream: "klaviyo", attempt: "A", status: resp.status });
    }

    console.log("✅ Klaviyo OK (Attempt A)", { email, ending_key, metric_name: KLAVIYO_METRIC_NAME });
    return res.status(200).json({ ok: true, attempt: "A" });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
