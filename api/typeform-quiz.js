// /api/typeform-quiz.js
// Typeform → Klaviyo: (1) Profile upsert + consent, (2) List subscribe, (3) Create event

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID; // <-- SET THIS (list: "Typeform bitquiz new")
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }
  if (!KLAVIYO_LIST_ID) {
    console.error("❌ Missing KLAVIYO_LIST_ID (List ID for 'Typeform bitquiz new')");
    return res.status(500).json({ error: "Server not configured" });
  }

  // Small helper for Klaviyo calls
  const kfetch = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        // Klaviyo expects this exact lowercase header key:
        revision: "2024-07-15",
      },
      body: JSON.stringify(body),
    });

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

    // --- (1) PROFILE UPSERT with explicit email marketing consent ---
    const profileBody = {
      data: {
        type: "profile",
        attributes: {
          email,
          subscriptions: {
            email: {
              marketing: {
                consent: true,
                timestamp: new Date().toISOString(), // consent time
              },
            },
          },
          // You can add more attributes if you want:
          // first_name: ...,
          // last_name: ...,
          // properties: { quiz_name, source } // optional custom props
        },
      },
    };

    console.log("👤 Upserting profile with consent...");
    const profileResp = await kfetch("https://a.klaviyo.com/api/profiles/", profileBody);
    if (!profileResp.ok) {
      const txt = await profileResp.text().catch(() => "");
      console.error("❌ Profile upsert error:", profileResp.status, txt?.slice(0, 1200));
      // Return 200 so Typeform doesn't retry forever, but include note
      return res.status(200).json({ ok: false, step: "profile_upsert", status: profileResp.status });
    }
    const profileJson = await profileResp.json().catch(() => ({}));
    const profileId = profileJson?.data?.id;
    if (!profileId) {
      console.error("❌ No profile ID returned from Klaviyo.");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }

    // --- (2) LIST SUBSCRIBE (creates the "Added to list" activity => triggers your Flow) ---
    const listRelBody = {
      data: [{ type: "profile", id: profileId }],
    };

    console.log("📝 Subscribing profile to list:", KLAVIYO_LIST_ID);
    const listResp = await kfetch(
      `https://a.klaviyo.com/api/lists/${KLAVIYO_LIST_ID}/relationships/profiles/`,
      listRelBody
    );
    if (!listResp.ok) {
      const txt = await listResp.text().catch(() => "");
      console.error("❌ List subscribe error:", listResp.status, txt?.slice(0, 1200));
      // We still continue to create the event, but Flow won't trigger without this.
      // Return 200 to keep Typeform green.
      return res.status(200).json({ ok: false, step: "list_subscribe", status: listResp.status });
    }

    // --- (3) CREATE EVENT (metric) ---
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
          },
          time: submittedAt,
          metric: {
            data: {
              type: "metric",
              attributes: { name: KLAVIYO_METRIC_NAME },
            },
          },
          profile: {
            data: {
              type: "profile",
              id: profileId, // link to the same profile we just upserted
            },
          },
          // unique_id: fr?.token, // optional dedupe key
        },
      },
    };

    console.log("📤 Posting Event (revision=2024-07-15, metric:", KLAVIYO_METRIC_NAME, ")");
    const eventResp = await kfetch("https://a.klaviyo.com/api/events/", eventBody);
    if (!eventResp.ok) {
      const txt = await eventResp.text().catch(() => "");
      console.error("❌ Klaviyo Event error:", eventResp.status, txt?.slice(0, 1200));
      return res.status(200).json({ ok: false, step: "event", status: eventResp.status });
    }

    console.log("✅ All good:", { email, ending_key, metric_name: KLAVIYO_METRIC_NAME });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
