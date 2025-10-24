// /api/typeform-quiz.js
// Typeform → Klaviyo: (1) Upsert profile, (2) Subscribe with consent, (3) Send event
// ✅ Handles consent + list + event automatically
// Requires env vars: KLAVIYO_API_KEY, KLAVIYO_LIST_ID, (optional) KLAVIYO_METRIC_NAME, TYPEFORM_SECRET

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.error("❌ Missing env vars (KLAVIYO_API_KEY or KLAVIYO_LIST_ID)");
    return res.status(500).json({ error: "Server not configured" });
  }

  const kfetch = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
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

    // Skip Typeform test payloads
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    if (isTypeformTest) {
      console.log("🧪 Typeform test payload – skipping Klaviyo");
      return res.status(200).json({ ok: true, note: "Typeform test – skipped" });
    }

    // Extract email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping" });
    }

    // Quiz data
    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = slugify(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending detected:", endingTitle, "→", ending_key);

    // (1) PROFILE UPSERT (no consent here)
    const profileBody = {
      data: {
        type: "profile",
        attributes: { email },
      },
    };

    console.log("👤 Upserting profile...");
    const profileResp = await kfetch("https://a.klaviyo.com/api/profiles/", profileBody);
    if (!profileResp.ok) {
      const txt = await profileResp.text().catch(() => "");
      console.error("❌ Profile upsert error:", profileResp.status, txt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "profile_upsert" });
    }
    const profileJson = await profileResp.json().catch(() => ({}));
    const profileId = profileJson?.data?.id;
    if (!profileId) {
      console.error("❌ No profile ID returned");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }

    // (2) SUBSCRIBE PROFILES (consent + add to list)
    const subscribeBody = {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          profiles: {
            data: [
              {
                type: "profile",
                id: profileId,
                attributes: {
                  email,
                  subscriptions: {
                    email: {
                      marketing: {
                        consent: "SUBSCRIBED",
                        consented_at: new Date().toISOString(),
                        method: "Typeform Quiz",
                        method_detail: source,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
        relationships: {
          list: { data: { type: "list", id: KLAVIYO_LIST_ID } },
        },
      },
    };

    console.log("✅ Subscribing profile with consent + list...");
    const subscribeResp = await kfetch(
      "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
      subscribeBody
    );
    if (!subscribeResp.ok) {
      const txt = await subscribeResp.text().catch(() => "");
      console.error("❌ Subscribe Profiles error:", subscribeResp.status, txt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "subscribe_profiles" });
    }

    // (3) EVENT
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
          metric: { data: { type: "metric", attributes: { name: KLAVIYO_METRIC_NAME } } },
          profile: { data: { type: "profile", id: profileId } },
        },
      },
    };

    console.log("📤 Posting Event:", KLAVIYO_METRIC_NAME);
    const eventResp = await kfetch("https://a.klaviyo.com/api/events/", eventBody);
    if (!eventResp.ok) {
      const txt = await eventResp.text().catch(() => "");
      console.error("❌ Klaviyo Event error:", eventResp.status, txt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "event" });
    }

    console.log("✅ All good:", { email, ending_key });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
