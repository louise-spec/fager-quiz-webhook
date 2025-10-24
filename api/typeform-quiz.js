// /api/typeform-quiz.js
// 1) Upsert profile (email only)
// 2) If consent=true: subscribe profile to List (via /api/lists/{LIST_ID}/relationships/profiles)
// 3) Create Event (metric by name, nested schema, revision 2024-07-15)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KLAVIYO_API_KEY     = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const KLAVIYO_LIST_ID     = process.env.KLAVIYO_LIST_ID || ""; // <-- sätt detta i Vercel
  const TYPEFORM_SECRET     = process.env.TYPEFORM_SECRET || "";
  const CONSENT_REF         = "318e5266-b416-4f99-acf3-17549aacf2f0"; // Typeform legal (boolean)

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().trim().replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "").slice(0, 60) || "unknown";

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr   = body?.form_response || {};

    // Skip Typeform test payloads
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending    === "hidden_value" ||
      fr?.hidden?.source    === "hidden_value";

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
      fr.hidden?.email || null;
    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Consent (Typeform legal → boolean)
    const consentAns   = (fr.answers || []).find((a) => a?.field?.ref === CONSENT_REF);
    const consentGiven = consentAns?.boolean === true;

    // Quiz fields
    const endingTitle  = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key   = slugify(endingTitle);
    const quiz_name    = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source       = fr?.hidden?.source || "Website";
    const submittedAt  = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending:", endingTitle, "→", ending_key, "| consent:", consentGiven);

    // ========= 1) UPSERT PROFILE (email only) =========
    try {
      const pResp = await fetch("https://a.klaviyo.com/api/profiles/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          revision: "2024-07-15",
        },
        body: JSON.stringify({ data: { type: "profile", attributes: { email } } }),
      });

      if (!pResp.ok) {
        const t = await pResp.text().catch(() => "");
        console.warn("⚠️ Profile upsert non-OK:", pResp.status, t?.slice(0, 800));
      } else {
        console.log("✅ Profile upserted (email only):", email);
      }
    } catch (e) {
      console.warn("⚠️ Profile upsert fetch error:", e?.message || e);
    }

    // ========= 2) SUBSCRIBE TO LIST (if consent) =========
    if (consentGiven && KLAVIYO_LIST_ID) {
      try {
        // Link profile to list by email-identifier
        const listPayload = {
          data: [{ type: "profile", id: `$email:${email}` }],
        };

        const lResp = await fetch(
          `https://a.klaviyo.com/api/lists/${encodeURIComponent(KLAVIYO_LIST_ID)}/relationships/profiles/`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
              revision: "2024-07-15",
            },
            body: JSON.stringify(listPayload),
          }
        );

        if (!lResp.ok) {
          const lt = await lResp.text().catch(() => "");
          console.error("❌ List subscribe error:", lResp.status, lt?.slice(0, 800));
        } else {
          console.log("✅ Subscribed to list:", KLAVIYO_LIST_ID, "→", email);
        }
      } catch (e) {
        console.error("❌ List subscribe fetch error:", e?.message || e);
      }
    } else if (consentGiven && !KLAVIYO_LIST_ID) {
      console.warn("⚠️ Consent true, but KLAVIYO_LIST_ID is not set. Skipping list subscribe.");
    }

    // ========= 3) CREATE EVENT =========
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
            typeform_response_id: fr?.token,
            consent_given: !!consentGiven,
          },
          time: submittedAt,
          metric: {
            data: { type: "metric", attributes: { name: KLAVIYO_METRIC_NAME } },
          },
          profile: {
            data: { type: "profile", attributes: { email } }, // referens med email
          },
          // unique_id: fr?.token, // valfritt: dedupe
        },
      },
    };

    console.log("📤 Posting Event (revision=2024-07-15, metric:", KLAVIYO_METRIC_NAME, ")");

    const eResp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-07-15",
      },
      body: JSON.stringify(eventBody),
    });

    if (!eResp.ok) {
      const txt = await eResp.text().catch(() => "");
      console.error("❌ Klaviyo event error:", eResp.status, txt?.slice(0, 1200));
      return res.status(200).json({ ok: false, upstream: "klaviyo", status: eResp.status });
    }

    console.log("✅ Klaviyo OK", {
      email,
      consent: !!consentGiven,
      ending_key,
      metric_name: KLAVIYO_METRIC_NAME,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
