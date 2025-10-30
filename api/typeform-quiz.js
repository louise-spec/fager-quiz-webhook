// /api/typeform-quiz.js
// Typeform → Klaviyo: upsert + subscribe + event
// PLUS: Spara *flera* quiz per person i `properties.quiz_history` (senaste först)
// + Robust hantering av 409 duplicate_profile (hämtar duplicate_profile_id / lookup via email)

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
  const kheaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
    revision: "2024-07-15",
  };

  const kpost  = (url, body) => fetch(url, { method: "POST",  headers: kheaders, body: JSON.stringify(body) });
  const kpatch = (url, body) => fetch(url, { method: "PATCH", headers: kheaders, body: JSON.stringify(body) });
  const kget   = (url)       => fetch(url, { headers: kheaders });

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
    if (typeof node === "string") { yield node; return; }
    if (Array.isArray(node)) { for (const v of node) yield* deepStrings(v); return; }
    if (typeof node === "object") { for (const k of Object.keys(node)) yield* deepStrings(node[k]); }
  }

  function extractFromStrings(fr) {
    let foundPath = null, foundEnding = null, foundGroup = null;
    const QUIZ_PATH_RE     = /(global\/(?:category|product|knowledge-base)\/[^\s?"']+)/i;
    const QUIZ_SHORT_RE    = /quiz-(young|snaffle|leverage)-\d+/i;
    const ENDING_IN_URL_RE = /[?&]ending=([A-Za-z0-9]+)(?:&|$)/i;
    const LABEL_PAIR_RE    = /\b([A-Za-zÅÄÖåäö]+[A-Za-zÅÄÖåäö0-9]+)\s+(quiz-(young|snaffle|leverage)-\d+)\b/i;

    for (const s of deepStrings(fr)) {
      const p1 = s.match(QUIZ_PATH_RE);     if (p1 && !foundPath)   foundPath   = p1[1];
      const e  = s.match(ENDING_IN_URL_RE); if (e  && !foundEnding) foundEnding = e[1];
      const lbl = s.match(LABEL_PAIR_RE);
      if (lbl) {
        if (!foundEnding) foundEnding = lbl[1];
        const short = lbl[2];
        if (!foundPath) foundPath = `global/category/${short.toLowerCase()}`;
        if (!foundGroup) foundGroup = lbl[3].toLowerCase();
      }
      if (!foundPath) {
        const q = s.match(QUIZ_SHORT_RE);
        if (q) { foundPath = `global/category/${q[0].toLowerCase()}`; if (!foundGroup) foundGroup = q[1].toLowerCase(); }
      }
    }
    return { foundPath, foundEnding, foundGroup };
  }

  function extractHorseName(fr) {
    const hiddenHorse = fr?.hidden?.horse_name || fr?.hidden?.horse || null;
    if (hiddenHorse) return hiddenHorse;
    const answers = fr?.answers || [];
    const lower = (s) => (s || "").toString().toLowerCase();
    const guess = answers.find((a) => {
      const title = lower(a?.field?.title) || lower(a?.field?.id) || lower(a?.field?.ref);
      return ["horse", "häst", "hästens namn", "horse name"].some((k) => title.includes(k));
    });
    if (!guess) return null;
    return guess?.text || guess?.email || guess?.choice?.label ||
           (typeof guess?.number === "number" ? String(guess.number) : null) ||
           guess?.date || null;
  }

  // ---- Robust profil-upsert som tål 409 ----
  async function findProfileIdByEmail(email) {
    try {
      const filter = encodeURIComponent(`equals(email,"${email}")`);
      const resp = await kget(`https://a.klaviyo.com/api/profiles/?filter=${filter}`);
      if (!resp.ok) return null;
      const j = await resp.json().catch(() => ({}));
      return j?.data?.[0]?.id || null;
    } catch { return null; }
  }

  async function getOrCreateProfileId(email) {
    try {
      const resp = await kpost("https://a.klaviyo.com/api/profiles/", {
        data: { type: "profile", attributes: { email } },
      });
      const txt = await resp.text().catch(() => "");

      if (resp.ok) {
        try { return JSON.parse(txt)?.data?.id || null; } catch { return null; }
      }
      if (resp.status === 409) {
        try {
          const err = JSON.parse(txt);
          const dupId = err?.errors?.[0]?.meta?.duplicate_profile_id;
          if (dupId) return dupId;
        } catch {}
        return await findProfileIdByEmail(email);
      }
      // 202 eller annat → prova lookup via email
      return await findProfileIdByEmail(email);
    } catch {
      return await findProfileIdByEmail(email);
    }
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr   = body?.form_response || {};

    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

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

    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email || null;

    if (!email) {
      console.warn("⚠️ No email; skipping Klaviyo");
      return res.status(200).json({ ok: true, note: "No email" });
    }

    const quiz_name   = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source      = fr?.hidden?.source || "Website";
    const horse_name  = extractHorseName(fr);
    let endingTitle   = fr?.calculated?.outcome?.title || fr?.hidden?.ending || null;

    const { foundPath, foundEnding, foundGroup } = extractFromStrings(fr);
    if (!endingTitle && foundEnding) endingTitle = foundEnding;

    const ending_key  = slugify(endingTitle || "unknown");
    let quiz_path     = foundPath ? foundPath.replace(/^global\//i, "global/").toLowerCase() : null;
    const quiz_group  = foundGroup || null;

    const submittedAt = fr?.submitted_at || new Date().toISOString();

    console.log("🧩 Ending detected:", endingTitle || "Unknown", "→", ending_key);
    console.log("🌐 Derived group/path:", quiz_group || "(unknown)", "→", quiz_path || "(none)");

    // ---------- upsert/hämta profile ID (tål 409) ----------
    console.log("👤 Upserting / resolving profile…");
    const profileId = await getOrCreateProfileId(email);
    if (!profileId) {
      console.error("❌ Could not resolve profile ID after upsert/lookup");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }
    console.log("👤 Profile ID:", profileId);

    // ---------- hämta existerande properties (för append) ----------
    let existingProps = {};
    try {
      const getResp = await kget(`https://a.klaviyo.com/api/profiles/${profileId}/`);
      if (getResp.ok) {
        const pj = await getResp.json();
        existingProps = pj?.data?.attributes?.properties || {};
      } else {
        console.warn("ℹ️ Could not GET profile before append:", getResp.status);
      }
    } catch (e) {
      console.warn("ℹ️ GET profile failed (non-blocking)", e);
    }

    // ---------- bygg historikpost & append ----------
    const newEntry = {
      date: submittedAt,
      horse: horse_name || null,
      ending: endingTitle || "Unknown",
      ending_key,
      quiz_path: quiz_path || null,
      quiz_group: quiz_group || null,
      quiz_name,
      source,
      typeform_form_id: fr?.form_id || null,
      typeform_response_id: fr?.token || null,
    };

    const history = Array.isArray(existingProps.quiz_history) ? [...existingProps.quiz_history] : [];
    history.unshift(newEntry);
    const trimmed = history.slice(0, 100);

    // ---------- set profile properties ----------
    const profileProps = {
      quiz_name,
      source,
      ending_title: endingTitle || "Unknown",
      ending_key,
      ...(quiz_path ? { quiz_path } : {}),
      ...(quiz_group ? { quiz_group } : {}),
      ...(horse_name ? { horse_name } : {}),
      quiz_history: trimmed,
    };

    await kpatch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
      data: { type: "profile", id: profileId, attributes: { properties: profileProps } },
    }).catch(() => {});

    // ---------- subscribe to list ----------
    console.log("✅ Subscribing (email-only) with consent + list (job) …");
    const subscribeResp = await kpost("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          profiles: {
            data: [{
              type: "profile",
              attributes: { email, subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } },
            }],
          },
        },
        relationships: { list: { data: { type: "list", id: KLAVIYO_LIST_ID } } },
      },
    });
    console.log(subscribeResp.ok ? "ℹ️ Subscribe accepted." : `ℹ️ Subscribe response: ${subscribeResp.status}`);

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
            ...(horse_name ? { horse_name } : {}),
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

    console.log("✅ All good:", { email, ending_key, quiz_path: quiz_path || "(none)", horse_name: horse_name || "(none)" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
