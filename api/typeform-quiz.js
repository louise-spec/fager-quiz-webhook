// /api/typeform-quiz.js
// Fager Quiz → Klaviyo: Profile props + Subscription + Event
// Auto-derive group & path from redirect hints (e.g. "quiz-snaffle-36") in URL Label or Hidden variables.
// Priority order:
// 1) Hidden overrides: quiz_path, quiz_group, ending
// 2) Outcome/Ending label: parse "quiz-(young|snaffle|leverage)-<n>" or "global/(product|knowledge-base)/..."
// 3) Fallbacks

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  console.log("▶️ Using Serverless Subscribe+Poll v2 (email-only)");

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
  const KLAVIYO_METRIC  = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
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
      .slice(0, 120) || "unknown";

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
      if (state === "succeeded" || state === "completed" || state === "complete") return true;
      if (state === "failed" || state === "error") { console.error("❌ Subscribe job failed:", t.slice(0, 800)); return false; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.log("ℹ️ Subscribe accepted but no terminal job status in time (continuing).");
    return false;
  };

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // Optional: ignore Typeform "Send test request"
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

    // --- Email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // ---------- Extract titles/labels ----------
    const labelLike =
      fr?.ending?.title ||
      fr?.ending?.label ||
      fr?.calculated?.outcome?.title || // may hold label text if Outcome was used
      "";

    const hidden = fr?.hidden || {};

    // Primary ending title
    const endingTitle =
      fr?.calculated?.outcome?.title ||
      hidden?.ending ||
      labelLike || // if label contains the name
      "Unknown";

    const ending_key = slugify(endingTitle);

    // Other simple fields
    const quiz_name   = hidden?.quiz_name || "FagerBitQuiz";
    const source      = hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // ---------- Derive quiz_group & quiz_path ----------
    // Highest priority: hidden overrides
    let quiz_path  = hidden?.quiz_path || null;
    let quiz_group = (hidden?.quiz_group || "").toLowerCase().trim() || null;

    // If not provided, try to parse redirect hints from label-like text
    //   e.g. "quiz-snaffle-36", "quiz-young-2", "quiz-leverage-13"
    //   or full "global/product/..." or "global/knowledge-base/..."
    const lowerLabel = String(labelLike || "").toLowerCase();

    // Regex helpers
    const reCategory = /(quiz-(young|snaffle|leverage)-\d+)/i;
    const reProduct  = /(global\/product\/[a-z0-9\-]+(\?[^\s]+)*)/i;
    const reKB       = /(global\/knowledge-base\/[a-z0-9\-]+(\?[^\s]+)*)/i;

    if (!quiz_path) {
      // Product / KB direct paths (if label carries full path)
      const mProd = lowerLabel.match(reProduct);
      const mKB   = lowerLabel.match(reKB);
      if (mProd?.[1]) {
        quiz_path = mProd[1]; // already relative path like "global/product/...."
        quiz_group = "product";
      } else if (mKB?.[1]) {
        quiz_path = mKB[1];
        quiz_group = "kb";
      }
    }

    if (!quiz_path) {
      // Category paths
      const mCat = lowerLabel.match(reCategory);
      if (mCat?.[1]) {
        quiz_path = `global/category/${mCat[1].toLowerCase()}`; // preserve digit suffix
        quiz_group = mCat[2].toLowerCase(); // young | snaffle | leverage
      }
    }

    // Final fallbacks if still missing
    if (!quiz_group && quiz_path) {
      if (quiz_path.includes("quiz-young-")) quiz_group = "young";
      else if (quiz_path.includes("quiz-snaffle-")) quiz_group = "snaffle";
      else if (quiz_path.includes("quiz-leverage-")) quiz_group = "leverage";
      else if (quiz_path.includes("global/product/")) quiz_group = "product";
      else if (quiz_path.includes("global/knowledge-base/")) quiz_group = "kb";
    }

    if (!quiz_path) {
      // Safe default if nothing parsed; you can change this if desired
      quiz_path = "global/category/quiz-young-2";
    }

    console.log("🧩 Ending detected:", endingTitle, "→", ending_key);
    console.log("🌐 Derived group/path:", quiz_group || "(unknown)", "→", quiz_path);

    // ---------- (1) PROFILE UPSERT ----------
    const profileBody = { data: { type: "profile", attributes: { email } } };
    console.log("👤 Upserting profile…");
    const profileResp = await kpost("https://a.klaviyo.com/api/profiles/", profileBody);
    const profileTxt  = await profileResp.text().catch(() => "");
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

    // ---------- (1b) PATCH PROFILE PROPERTIES ----------
    try {
      const profileUpdateBody = {
        data: {
          type: "profile",
          id: profileId,
          attributes: {
            properties: {
              quiz_name,
              ending_title: endingTitle,
              ending_key,
              source,
              quiz_group: quiz_group || null,
              quiz_path
            }
          }
        }
      };

      const upd = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          revision: "2024-07-15"
        },
        body: JSON.stringify(profileUpdateBody)
      });
      const updTxt = await upd.text().catch(() => "");
      if (!upd.ok) console.error("❌ Profile properties PATCH error:", upd.status, updTxt.slice(0, 400));
      else console.log("📝 Profile properties set:", { quiz_name, endingTitle, ending_key, source, quiz_group, quiz_path });
    } catch (e) {
      console.error("❌ Profile properties PATCH failed:", e?.message || e);
    }

    // ---------- (2) SUBSCRIBE (bulk job; consent + list) ----------
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
                  subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } }
                }
              }
            ]
          }
        },
        relationships: { list: { data: { type: "list", id: KLAVIYO_LIST_ID } } }
      }
    };

    console.log("✅ Subscribing (email-only) with consent + list (creating job)...");
    const subResp = await kpost("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", subscribeBody);
    const subHdrs = Object.fromEntries(subResp.headers.entries());
    const jobUrl  = subHdrs["content-location"] || subHdrs["location"] || null;
    if (jobUrl) await pollJob(jobUrl);
    else console.log("ℹ️ Subscribe accepted (no job URL header); proceeding.");

    // ---------- (3) EVENT ----------
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name,
            ending_key,
            ending_title: endingTitle,
            source,
            quiz_group: quiz_group || null,
            quiz_path,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token
          },
          time: submittedAt,
          metric:  { data: { type: "metric",  attributes: { name: KLAVIYO_METRIC } } },
          profile: { data: { type: "profile", id: profileId } }
        }
      }
    };
    console.log("📤 Posting Event:", KLAVIYO_METRIC);
    const eventResp = await kpost("https://a.klaviyo.com/api/events/", eventBody);
    const eventTxt  = await eventResp.text().catch(() => "");
    if (!eventResp.ok) {
      console.error("❌ Klaviyo Event error:", eventResp.status, eventTxt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "event", status: eventResp.status });
    }

    console.log("✅ All good:", { email, ending_key, quiz_path });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
