// /api/typeform-quiz.js
// Typeform → Klaviyo (Production):
// 1) Upsert profile
// 2) Subscribe (email consent + add to list) via email-only bulk job (+ light polling)
// 3) Send event
//
// Env: KLAVIYO_API_KEY, KLAVIYO_LIST_ID, (opt) KLAVIYO_METRIC_NAME, TYPEFORM_SECRET

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
  const KLAVIYO_METRIC_NAME = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    // Hårda fel loggas server-side, men vi svarar 500 här då det är konfigurationsfel.
    console.error("Missing env vars (KLAVIYO_API_KEY or KLAVIYO_LIST_ID)");
    return res.status(500).json({ error: "Server not configured" });
  }

  // --- Helpers ---
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

  // Kort & snäll polling (max ~30s) för att vänta in subscribe-jobbet
  const pollJob = async (url, timeoutMs = 30000, intervalMs = 3000) => {
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
      if (state === "succeeded" || state === "completed" || state === "complete") return true;
      if (state === "failed" || state === "error") {
        console.error("Subscribe job failed:", t.slice(0, 400));
        return false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false; // inte kritiskt; flowet har delay hos dig
  };

  try {
    // --- Parse & guardrails ---
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // Blockera Typeforms "Send test request"
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    // Valfri extra-säkerhet med secret
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    if (isTypeformTest) {
      return res.status(200).json({ ok: true, note: "Typeform test – skipped" });
    }

    // --- Email extraction ---
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      // vi svarar 200 så Typeform inte loopar, men gör inget upstream
      return res.status(200).json({ ok: true, note: "No email; skipped" });
    }

    // --- Quiz fields (valfria att använda i eventet) ---
    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = slugify(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // --- (1) PROFILE UPSERT ---
    const profileBody = {
      data: {
        type: "profile",
        attributes: { email },
      },
    };
    const profileResp = await kpost("https://a.klaviyo.com/api/profiles/", profileBody);
    const profileTxt = await profileResp.text().catch(() => "");
    if (!profileResp.ok) {
      console.error("Profile upsert error:", profileResp.status, profileTxt.slice(0, 400));
      return res.status(200).json({ ok: false, step: "profile_upsert" });
    }
    let profileJson = {};
    try { profileJson = JSON.parse(profileTxt); } catch {}
    const profileId = profileJson?.data?.id;
    if (!profileId) {
      console.error("No profile ID returned");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }

    // --- (2) SUBSCRIBE (email consent + add to list) via email-only bulk-job ---
    // OBS: Inga method/consented_at-fält i marketing; de orsakar 400 i non-historical subscription.
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
                      marketing: {
                        consent: "SUBSCRIBED",
                      },
                    },
                  },
                },
              },
            ],
          },
          // historical_import lämnas bort (vi vill trigga list-flows)
        },
        relationships: { list: { data: { type: "list", id: KLAVIYO_LIST_ID } } },
      },
    };

    const subscribeResp = await kpost(
      "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
      subscribeBody
    );
    const subscribeStatus = subscribeResp.status;
    const subscribeHeaders = Object.fromEntries(subscribeResp.headers.entries());
    const jobUrl = subscribeHeaders["content-location"] || subscribeHeaders["location"] || null;
    const subscribeTxt = await subscribeResp.text().catch(() => "");
    if (!subscribeResp.ok) {
      console.error("Subscribe error:", subscribeStatus, subscribeTxt.slice(0, 400));
      // Fortsätt ändå till event så Typeform inte får rött; flowet har redan delay hos dig
    } else if (jobUrl) {
      // Vänta kort på att jobbet blir klart (så UI/flow hinner ikapp)
      await pollJob(jobUrl).catch(() => {});
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
          // unique_id: fr?.token, // valfritt dedupe
        },
      },
    };

    const eventResp = await kpost("https://a.klaviyo.com/api/events/", eventBody);
    const eventTxt = await eventResp.text().catch(() => "");
    if (!eventResp.ok) {
      console.error("Event error:", eventResp.status, eventTxt.slice(0, 400));
      return res.status(200).json({ ok: false, step: "event" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    // Alltid 200 till Typeform för att undvika retry storms, men notera ok=false
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
