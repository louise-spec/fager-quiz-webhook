// /api/typeform-quiz.js
// Typeform → Klaviyo: robust extract (ending + quiz_path) + subscribe + event

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KLAVIYO_API_KEY   = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID   = process.env.KLAVIYO_LIST_ID;
  const KLAVIYO_METRIC    = process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET   = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.error("❌ Missing env vars (KLAVIYO_API_KEY or KLAVIYO_LIST_ID)");
    return res.status(500).json({ error: "Server not configured" });
  }

  // ---------- helpers ----------
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

  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown";

  function* deepStrings(node) {
    if (!node) return;
    if (typeof node === "string") {
      yield node; return;
    }
    if (Array.isArray(node)) { for (const v of node) yield* deepStrings(v); return; }
    if (typeof node === "object") { for (const k of Object.keys(node)) yield* deepStrings(node[k]); }
  }

  // Plockar ending + path från allt som kan finnas i payloaden
  function extractFromStrings(fr) {
    let foundPath = null;   // global/category/quiz-snaffle-36  eller product/… / knowledge-base/…
    let foundEnding = null; // HildaMaria
    let foundGroup = null;  // young | snaffle | leverage

    const QUIZ_PATH_RE     = /(global\/(?:category|product|knowledge-base)\/[^\s?"']+)/i;
    const QUIZ_SHORT_RE    = /quiz-(young|snaffle|leverage)-\d+/i;
    const ENDING_IN_URL_RE = /[?&]ending=([A-Za-z0-9]+)(?:&|$)/i;
    const LABEL_PAIR_RE    = /\b([A-Za-zÅÄÖåäö]+[A-Za-zÅÄÖåäö0-9]+)\s+(quiz-(young|snaffle|leverage)-\d+)\b/i;

    for (const s of deepStrings(fr)) {
      // Hela pathen?
      const p1 = s.match(QUIZ_PATH_RE);
      if (p1 && !foundPath) foundPath = p1[1];

      // ending=Name i URL
      const e = s.match(ENDING_IN_URL_RE);
      if (e && !foundEnding) foundEnding = e[1];

      // "EndingName quiz-xxx-n" (vår URL Label)
      const lbl = s.match(LABEL_PAIR_RE);
      if (lbl) {
        if (!foundEnding) foundEnding = lbl[1];
        const short = lbl[2]; // quiz-snaffle-36
        if (!foundPath) foundPath = `global/category/${short.toLowerCase()}`;
        if (!foundGroup) foundGroup = lbl[3].toLowerCase();
      }

      // Endast short?
      if (!foundPath) {
        const q = s.match(QUIZ_SHORT_RE);
        if (q) {
          foundPath = `global/category/${q[0].toLowerCase()}`;
          if (!foundGroup) foundGroup = q[1].toLowerCase();
        }
      }
    }
    return { foundPath, foundEnding, foundGroup };
  }

  try {
    // ---------- parse ----------
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr   = body?.form_response || {};

    // Stoppa Typeforms "Send test request"
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    // Valfri shared secret
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignored");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    if (isTypeformTest) {
      console.log("🧪 Typeform test payload – no-op");
      return res.status(200).json({ ok: true, note: "Typeform test – skipped" });
    }

    // email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email; skipping Klaviyo");
      return res.status(200).json({ ok: true, note: "No email" });
    }

    // Grunddata
    const quiz_name   = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source      = fr?.hidden?.source || "Website";
    let endingTitle   = fr?.calculated?.outcome?.title || fr?.hidden?.ending || null;

    // Försök extrahera från strängar (URL + Label)
    const { foundPath, foundEnding, foundGroup } = extractFromStrings(fr);
    if (!endingTitle && foundEnding) endingTitle = foundEnding;

    const ending_key  = slugify(endingTitle || "unknown");
    let   quiz_path   = null;
    if (foundPath) {
      // normalisera
      quiz_path = foundPath.replace(/^global\//i, "global/").toLowerCase();
    }
    const quiz_group  = foundGroup || null;

    const submittedAt = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending detected:", endingTitle || "Unknown", "→", ending_key);
    console.log("🌐 Derived group/path:", quiz_group || "(unknown)", "→", quiz_path || "(none)");

    // ---------- upsert profile ----------
    console.log("👤 Upserting profile…");
    const profileResp = await kpost("https://a.klaviyo.com/api/profiles/", {
      data: { type: "profile", attributes: { email } },
    });
    const profileTxt  = await profileResp.text().catch(() => "");
    if (!profileResp.ok) {
      console.error("❌ Profile upsert:", profileResp.status, profileTxt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "profile_upsert", status: profileResp.status });
    }
    let profileJson = {};
    try { profileJson = JSON.parse(profileTxt); } catch {}
    const profileId = profileJson?.data?.id;
    if (!profileId) {
      console.error("❌ No profile ID");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }
    console.log("👤 Profile ID:", profileId);

    // ---------- set profile properties (custom) ----------
    const profileProps = {
      quiz_name,
      source,
      ending_title: endingTitle || "Unknown",
      ending_key,
      ...(quiz_path ? { quiz_path } : {}),
      ...(quiz_group ? { quiz_group } : {}),
    };

    // Patcha profil med properties (valfritt men bra)
    await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-07-15",
      },
      body: JSON.stringify({
        data: {
          type: "profile",
          id: profileId,
          attributes: { properties: profileProps },
        },
      }),
    }).catch(() => {});

    // ---------- subscribe to list (email-only) ----------
    console.log("✅ Subscribing (email-only) with consent + list (job) …");
    const subscribeResp = await kpost(
      "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
      {
        data: {
          type: "profile-subscription-bulk-create-job",
          attributes: {
            profiles: {
              data: [
                {
                  type: "profile",
                  attributes: {
                    email,
                    subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } },
                  },
                },
              ],
            },
          },
          relationships: { list: { data: { type: "list", id: KLAVIYO_LIST_ID } } },
        },
      }
    );
    console.log(
      subscribeResp.ok
        ? "ℹ️ Subscribe accepted."
        : `ℹ️ Subscribe response: ${subscribeResp.status}`
    );

    // ---------- event ----------
    console.log("📤 Posting Event:", KLAVIYO_METRIC);
    const eventResp = await kpost("https://a.klaviyo.com/api/events/", {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name,
            ending_key,
            ending_title: endingTitle || "Unknown",
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token,
            ...(quiz_path ? { quiz_path } : {}),
          },
          time: submittedAt,
          metric:  { data: { type: "metric", attributes: { name: KLAVIYO_METRIC } } },
          profile: { data: { type: "profile", id: profileId } },
        },
      },
    });
    const eventTxt = await eventResp.text().catch(() => "");
    if (!eventResp.ok) {
      console.error("❌ Event error:", eventResp.status, eventTxt.slice(0, 800));
      return res.status(200).json({ ok: false, step: "event", status: eventResp.status });
    }

    console.log("✅ All good:", { email, ending_key, quiz_path: quiz_path || "(none)" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
