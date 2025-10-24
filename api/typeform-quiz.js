// /api/typeform-quiz.js
// Fager Quiz → Klaviyo Events + Subscription (working version)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  console.log("▶️ Using Serverless Subscribe+Poll v2 (email-only)");

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.error("❌ Missing env vars (KLAVIYO_API_KEY or KLAVIYO_LIST_ID)");
    return res.status(500).json({ error: "Server not configured" });
  }

  // === Helpers ===
  const kpost = (url, body) =>
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

  const kget = (url) =>
    fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-07-15",
      },
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

  const pollJob = async (url, timeoutMs = 45000, intervalMs = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const r = await kget(url);
      const t = await r.text().catch(() => "");
      let json = null;
      try { json = JSON.parse(t); } catch {}
      const state =
        json?.data?.attributes?.status ||
        json?.data?.attributes?.job_status ||
        "unknown";
      console.log(`🔄 Subscribe job status: ${state}`);
      if (state === "succeeded" || state === "completed" || state === "complete") {
        console.log("🎉 Subscribe job completed");
        return true;
      }
      if (state === "failed" || state === "error") {
        console.error("❌ Subscribe job failed:", t.slice(0, 800));
        return false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.warn("⏱️ Subscribe job polling timed out");
    return false;
  };

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // Blockera Typeforms test request
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

    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping" });
    }

    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = slugify(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending detected:", endingTitle, "→", ending_key);

    // --- (1) PROFILE UPSERT ---
    const profileBody = { data: { type: "profile", attributes: { email } } };
    console.log("👤 Upserting profile…");
    const profileResp = await kpost("https://a.klaviyo.com/api/profiles/", profileBody);
    const profileTxt = await profileResp.text().catch(() => "");
    if (!profileResp.ok) {
      console.error("❌ Profile upsert error:", profileResp.status, profileTxt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "profile_upsert", status: profileResp.status });
    }
    let profileJson = {};
    try { profileJson = JSON.parse(profileTxt); } catch {}
    const profileId = profileJson?.data?.id;
    if (!profileId) {
      console.error("❌ No profile ID returned");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }
    console.log("👤 Profile ID:", profileId);

    // --- (2) SUBSCRIBE (email-only) via bulk-job (no consented_at/method) ---
    const subscribeBody = {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          profiles: {
            data: [
              {
                type: "profile",
                attributes: {
                  email,
                  subscriptions: {
                    email: {
                      marketing: { consent: "SUBSCRIBED" }
                    }
                  }
                }
              }
            ]
          }
        },
        relationships: { list: { data: { type: "list", id: KLAVIYO_LIST_ID } } }
      }
    };

    console.log("✅ Subscribing (email-only) with consent + list (creating job)...");
    const subscribeResp = await kpost("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", subscribeBody);
    const subscribeStatus = subscribeResp.status;
    const subscribeHeaders = Object.fromEntries(subscribeResp.headers.entries());
    const jobUrl = subscribeHeaders["content-location"] || subscribeHeaders["location"] || null;
    const subscribeTxtFirst = await subscribeResp.text().catch(() => "");
    console.log("Subscribe status:", subscribeStatus);
    console.log("Subscribe headers:", subscribeHeaders);
    console.log("Subscribe response (first 500):", subscribeTxtFirst.slice(0, 500));
    if (subscribeResp.ok && jobUrl) {
      const jobOk = await pollJob(jobUrl);
      if (!jobOk) console.warn("⚠️ Consent/list may not be finalized yet; proceeding to event.");
    } else {
      console.error("❌ Subscribe Profiles error or missing job URL");
    }

    // --- (3) EVENT ---
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
    const eventResp = await kpost("https://a.klaviyo.com/api/events/", eventBody);
    const eventTxt = await eventResp.text().catch(() => "");
    if (!eventResp.ok) {
      console.error("❌ Klaviyo Event error:", eventResp.status, eventTxt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "event", status: eventResp.status });
    }

    console.log("✅ All good:", { email, ending_key });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
