// /api/typeform-webhook.js
// Typeform → Klaviyo (Vercel/Next.js)
// - Upsert/resolve profile (handles 409 duplicate_profile)
// - Save full quiz_history (latest first)
// - Do NOT overwrite properties with null (keeps last good values)
// - Derive ending_key from ending_title when missing
// - Detect horse_name via ref/hidden/label, fallback to first non-email text
// - Extract ending + quiz_path from ANY strings (URLs, URL Labels "Name slug", quiz-short)
// - Auto-derive quiz_group from quiz_path (young/snaffle/leverage) on every run
// - Proper Events API payload: metric/profile use { data: ... }
// - ✅ Email validation: stops invalid email before touching Klaviyo
// - ✅ Path normalization: always store quiz_path as category|product|knowledge-base WITHOUT "global/"
// - ✅ Label-pair quiz slugs (quiz-*) → category/quiz-… (prevents /product/quiz-… 404)
// - ✅ Language detection from URLs / hidden → language, newsletter_group, Country

const KLAVIYO_API_BASE = "https://a.klaviyo.com/api";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body   = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr     = body?.form_response || {};
    const nowISO = new Date().toISOString();

    // Optional shared secret
    const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignored");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // Ignore Typeform test payload
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";
    if (isTypeformTest) {
      console.log("🧪 Typeform test payload – no-op");
      return res.status(200).json({ ok: true, note: "Typeform test – skipped" });
    }

    // 1) Normalize fields (raw + hidden + answers)
    let {
      email,
      horse_name,
      ending_title,
      ending_key: ending_key_raw,
      quiz_path,
      quiz_name,
      source
    } = normalizeTypeformPayload(body);

    // ✅ Normalize any incoming quiz_path from Typeform (URL or path)
    quiz_path = normalizeQuizPath(quiz_path);

    // ✅ Email normalization + validation (prevents "Email Syntax Error")
    if (typeof email === "string") email = email.trim();
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !EMAIL_RE.test(email)) {
      console.warn("⚠️ Invalid email syntax:", email);
      return res.status(200).json({ ok: true, note: "Invalid email syntax" });
    }

    // 2) EXTRA: deep extract from all strings (URL labels, URLs, quiz-short)
    const { foundPath, foundEnding } = extractFromStrings(fr);
    if (!ending_title && foundEnding) ending_title = foundEnding;
    if (!quiz_path && foundPath) quiz_path = foundPath; // already normalized

    // ending_key from title when missing
    const ending_key = ending_key_raw || (ending_title ? safeSlug(ending_title) : null);

    // derive current quiz_group from path
    const quiz_group_current = deriveQuizGroup(quiz_path);

    // 3) Resolve profile id
    const profileId = await getOrCreateProfileId(email);
    if (!profileId) {
      console.error("❌ Could not resolve profile ID");
      return res.status(200).json({ ok: false, step: "profile_id_missing" });
    }

    // 4) Read existing properties (for history + no-null overwrite)
    const existingProps = await getProfileProperties(profileId);

    // 5) Build new history entry and append (latest first)
    const newEntry = {
      date: fr?.submitted_at || nowISO,
      horse: horse_name || null,
      ending: ending_title || null,
      ending_key: ending_key || null,
      quiz_path: quiz_path || null,
      quiz_group: quiz_group_current || null,
      quiz_name: quiz_name || "Fager Quiz",
      source: source || "typeform",
      typeform_form_id: fr?.form_id || null,
      typeform_response_id: fr?.token || null,
    };

    const prevHistory = Array.isArray(existingProps.quiz_history) ? existingProps.quiz_history : [];
    const history = [newEntry, ...prevHistory].slice(0, 100);

    // 6) “Last good value” fallbacks so we never blank out fields
    const latestWithEnding = history.find(e => e?.ending || e?.ending_key || e?.quiz_path) || {};

    const ending_title_final = ending_title ?? latestWithEnding.ending ?? existingProps.ending_title ?? null;
    const ending_key_final   = ending_key   ?? latestWithEnding.ending_key ?? existingProps.ending_key ?? null;
    const quiz_path_final    = quiz_path    ?? latestWithEnding.quiz_path  ?? existingProps.quiz_path  ?? null;
    const quiz_group_final =
      quiz_group_current
      ?? deriveQuizGroup(latestWithEnding.quiz_path)
      ?? deriveQuizGroup(existingProps.quiz_path)
      ?? existingProps.quiz_group
      ?? null;
    const quiz_name_final    = quiz_name    ?? existingProps.quiz_name ?? "Fager Quiz";
    const source_final       = source       ?? existingProps.source    ?? "typeform";
    const horse_name_final   = horse_name   ?? existingProps.horse_name ?? null;

    // 7) LANGUAGE + COUNTRY + NEWSLETTER GROUP
    //    - Language drives flows (sv, en, fr, es, de, no, da...)
    //    - newsletter_group = "se" for sv, otherwise "global"
    //    - Country (e.g. "Sweden") can be used in older segment definitions
    const language_detected =
      detectLanguageFromFormResponse(fr) ||        // from URLs / hidden
      languageFromEndingKey(ending_key_final) ||   // if you prefix endings later
      existingProps.language ||                    // keep previous if any
      null;

    const language_final = language_detected || "en";

    const newsletter_group_final = language_final === "sv" ? "se" : "global";

    const country_from_language = mapLanguageToCountry(language_final);
    const country_final =
      country_from_language ||
      existingProps.Country ||
      existingProps.country ||
      null;

    // 8) Patch profile properties (no null overwrites)
    const propertiesPatch = {
      ...(horse_name_final       ? { horse_name: horse_name_final } : {}),
      ...(ending_title_final     ? { ending_title: ending_title_final } : {}),
      ...(ending_key_final       ? { ending_key: ending_key_final } : {}),
      ...(quiz_path_final        ? { quiz_path:  quiz_path_final } : {}),
      ...(quiz_group_final       ? { quiz_group: quiz_group_final } : {}),
      ...(quiz_name_final        ? { quiz_name:  quiz_name_final } : {}),
      ...(source_final           ? { source:     source_final } : {}),
      ...(language_final         ? { language:   language_final } : {}),
      ...(newsletter_group_final ? { newsletter_group: newsletter_group_final } : {}),
      ...(country_final          ? { Country:    country_final } : {}),
      quiz_history: history
    };
    await patchProfileProperties(profileId, propertiesPatch);

    // 9) Subscribe to list (optional)
    if (process.env.KLAVIYO_LIST_ID) {
      await subscribeProfileToList(email, process.env.KLAVIYO_LIST_ID);
    }

    // 10) Post event with correct payload shape
    await sendEventToKlaviyo({
      metric_name: process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed",
      profile_id: profileId,
      properties: {
        ...(quiz_name_final        ? { quiz_name:  quiz_name_final } : {}),
        ...(ending_title_final     ? { ending_title: ending_title_final } : {}),
        ...(ending_key_final       ? { ending_key:  ending_key_final } : {}),
        ...(quiz_path_final        ? { quiz_path:  quiz_path_final } : {}),
        ...(quiz_group_final       ? { quiz_group: quiz_group_final } : {}),
        ...(horse_name_final       ? { horse_name: horse_name_final } : {}),
        ...(source_final           ? { source:     source_final } : {}),
        ...(language_final         ? { language:   language_final } : {}),
        ...(newsletter_group_final ? { newsletter_group: newsletter_group_final } : {}),
        ...(country_final          ? { Country:    country_final } : {}),
        submitted_at: fr?.submitted_at || nowISO,
      },
      time: fr?.submitted_at || nowISO
    });

    console.log("✅ All good:", {
      email,
      ending_key:       ending_key_final || "(none)",
      quiz_path:        quiz_path_final || "(none)",
      quiz_group:       quiz_group_final || "(none)",
      horse_name:       horse_name_final || "(none)",
      language:         language_final || "(none)",
      newsletter_group: newsletter_group_final || "(none)",
      Country:          country_final || "(none)"
    });

    return res.status(200).json({ ok: true, profile_id: profileId, appended: newEntry });
  } catch (err) {
    console.error("💥 Webhook error", err);
    return res.status(500).json({ error: "Internal error", details: String(err?.message || err) });
  }
}

/* ========================= Helpers ========================= */

function headers() {
  const revision = process.env.KLAVIYO_REVISION || "2024-07-15";
  return {
    "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Revision": revision
  };
}

const kget   = (url)       => fetch(url, { headers: headers() });
const kpost  = (url, body) => fetch(url, { method: "POST",  headers: headers(), body: JSON.stringify(body) });
const kpatch = (url, body) => fetch(url, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });

function safeSlug(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unknown";
}

function deriveQuizGroup(path) {
  if (!path) return null;
  const m = String(path).match(/quiz-(young|snaffle|leverage)/i);
  return m ? m[1].toLowerCase() : null;
}

// ✅ Normalize quiz_path: strip domain, leading "/", and "global/"; coerce quiz-* → category/quiz-*
function normalizeQuizPath(p) {
  if (!p) return null;
  let s = String(p).toLowerCase().trim();

  // If full URL, extract path part
  const mUrl = s.match(/https?:\/\/[^/]+\/(.+)$/i);
  if (mUrl) s = mUrl[1];

  // Remove leading slash
  s = s.replace(/^\/+/, "");

  // Remove "global/" prefix
  s = s.replace(/^global\//, "");

  // If it's a quiz-short without prefix, coerce to category/…
  if (/^quiz-(young|snaffle|leverage)-\d+$/i.test(s)) {
    s = `category/${s}`;
  }

  // Keep only valid roots
  if (!/^(category|product|knowledge-base)\//.test(s)) return null;

  return s;
}

/* ---------- Language / country helpers ---------- */

function languageFromEndingKey(endingKey) {
  if (!endingKey) return null;
  const s = String(endingKey).toLowerCase();
  if (s.startsWith("sv_") || s.startsWith("sv-")) return "sv";
  if (s.startsWith("en_") || s.startsWith("en-")) return "en";
  if (s.startsWith("fr_") || s.startsWith("fr-")) return "fr";
  if (s.startsWith("es_") || s.startsWith("es-")) return "es";
  if (s.startsWith("de_") || s.startsWith("de-")) return "de";
  if (s.startsWith("no_") || s.startsWith("no-")) return "no";
  if (s.startsWith("da_") || s.startsWith("da-")) return "da";
  return null;
}

function mapLanguageToCountry(lang) {
  switch ((lang || "").toLowerCase()) {
    case "sv": return "Sweden";
    case "no": return "Norway";
    case "da": return "Denmark";
    case "de": return "Germany";
    case "fr": return "France";
    case "es": return "Spain";
    // engelska och övriga → ingen specifik country (hamnar ändå i Newsletter – Global)
    default:   return null;
  }
}

function detectLanguageFromFormResponse(fr) {
  if (!fr) return null;

  // 1) Explicit hidden language if du lägger till det i Typeform (rekommenderat)
  const hiddenLang = fr?.hidden?.language || fr?.hidden?.lang;
  if (typeof hiddenLang === "string" && hiddenLang.trim()) {
    const v = hiddenLang.trim().toLowerCase();
    if (["sv", "en", "fr", "es", "de", "no", "da"].includes(v)) return v;
  }

  // 2) Leta efter /sv/ /en/ /fr/ /es/ /de/ /no/ /da/ i alla strängar (t.ex. redirect-URL:er)
  const LANG_RE = /\/(sv|en|fr|es|de|no|da)(?:\/|$)/i;
  for (const raw of deepStrings(fr)) {
    const s = typeof raw === "string" ? raw : String(raw);
    const m = s.match(LANG_RE);
    if (m) return m[1].toLowerCase();
  }

  return null;
}

async function getProfileProperties(profileId) {
  try {
    const resp = await kget(`${KLAVIYO_API_BASE}/profiles/${profileId}/`);
    if (!resp.ok) return {};
    const j = await resp.json().catch(() => ({}));
    return j?.data?.attributes?.properties || {};
  } catch {
    return {};
  }
}

async function patchProfileProperties(profileId, properties) {
  try {
    const body = { data: { type: "profile", id: profileId, attributes: { properties } } };
    const resp = await kpatch(`${KLAVIYO_API_BASE}/profiles/${profileId}/`, body);
    if (!resp.ok) {
      const t = await resp.text();
      console.warn("Profile patch non-OK", resp.status, t);
    }
  } catch (e) {
    console.warn("Profile patch error", e);
  }
}

async function subscribeProfileToList(email, listId) {
  try {
    const resp = await kpost(`${KLAVIYO_API_BASE}/profile-subscription-bulk-create-jobs/`, {
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
        relationships: { list: { data: { type: "list", id: listId } } },
      },
    });
    console.log(resp.ok ? "ℹ️ Subscribe accepted." : `ℹ️ Subscribe response: ${resp.status}`);
  } catch (e) {
    console.warn("Subscribe job error", e);
  }
}

async function sendEventToKlaviyo({ metric_name, profile_id, properties, time }) {
  try {
    const body = {
      data: {
        type: "event",
        attributes: {
          properties,
          time: time || new Date().toISOString(),
          metric:  { data: { type: "metric",  attributes: { name: metric_name } } },
          profile: { data: { type: "profile", id: profile_id } },
        },
      },
    };
    const resp = await kpost(`${KLAVIYO_API_BASE}/events/`, body);
    if (!resp.ok) {
      const t = await resp.text();
      console.warn("Event post non-OK", resp.status, t);
    }
  } catch (e) {
    console.warn("Event post error", e);
  }
}

/* ---------- Typeform normalization ---------- */

function normalizeTypeformPayload(payload) {
  // Priority: direct keys → hidden → answers by ref → guess by label → fallback to first non-email text
  const direct  = (k) => payload?.[k] ?? payload?.[k?.toLowerCase?.()] ?? null;
  const hidden  = payload?.form_response?.hidden || {};
  const answers = payload?.form_response?.answers || [];

  const byRef = (ref) => {
    if (!ref) return null;
    const a = answers.find(x => x?.field?.ref === ref);
    return extractAnswerValue(a);
  };
  const byType = (t) => extractAnswerValue(answers.find(x => x?.type === t));

  // First free-text answer that isn't the email answer (fallback)
  const firstNonEmailText = () => {
    const a = answers.find(x => x?.type === "text" && !x?.email);
    return extractAnswerValue(a);
  };

  const email = direct("email") || hidden.email || byRef("email") || byType("email");

  let horse_name =
    direct("horse_name") ||
    hidden.horse_name ||
    byRef("horse_name") ||
    guessByLabel(answers, ["horse", "häst", "hästens namn", "horse name"]);
  if (!horse_name) horse_name = firstNonEmailText();

  const ending_title =
    direct("ending_title") ||
    hidden.ending_title ||
    byRef("ending_title") ||
    guessByLabel(answers, ["ending title", "result", "slut", "resultat"]);

  const ending_key = direct("ending_key") || hidden.ending_key || byRef("ending_key");
  const quiz_path  = direct("quiz_path")  || hidden.quiz_path  || byRef("quiz_path");
  const quiz_name  = direct("quiz_name")  || hidden.quiz_name  || byRef("quiz_name") || "Fager Quiz";
  const source     = direct("source")     || hidden.source     || byRef("source")    || "typeform";

  try { console.log("🧪 Detected horse_name:", horse_name || "(none)"); } catch {}

  return { email, horse_name, ending_title, ending_key, quiz_path, quiz_name, source };
}

function extractAnswerValue(a) {
  if (!a) return null;
  if (a.email) return a.email;
  if (a.text) return a.text;
  if (a.choice?.label) return a.choice.label;
  if (typeof a.number === "number") return a.number;
  if (a.boolean === true || a.boolean === false) return a.boolean;
  if (a.date) return a.date;
  return null;
}

function guessByLabel(answers, keywords) {
  const lower = (s) => (s || "").toString().toLowerCase();
  const match = answers.find(a =>
    keywords.some(k =>
      lower(a?.field?.ref).includes(lower(k)) ||
      lower(a?.field?.id).includes(lower(k)) ||
      lower(a?.field?.title).includes(lower(k))
    )
  );
  return extractAnswerValue(match);
}

/* ---------- Deep scan to extract ending/path from any strings ---------- */

// iterate all strings in an object
function* deepStrings(node) {
  if (!node) return;
  if (typeof node === "string") { yield node; return; }
  if (Array.isArray(node)) { for (const v of node) yield* deepStrings(v); return; }
  if (typeof node === "object") { for (const k of Object.keys(node)) yield* deepStrings(node[k]); }
}

// Finds (normalized):
// - full URLs → strip domain & global/, keep category|product|knowledge-base/...
// - plain paths (with or without global/)
// - URL param: ?ending=Name
// - label pair: "ReadableName slug-with-dashes" → product OR category(quiz-*)
// - quiz short: quiz-young-2 → category/quiz-young-2
function extractFromStrings(fr) {
  let foundPath = null;
  let foundEnding = null;

  const PATH_IN_URL_RE   = /https?:\/\/[^\/]+\/((?:global\/)?(?:category|product|knowledge-base)\/[^\s?"']+)/i;
  const PLAIN_PATH_RE    = /(?:^|[\s"'`])((?:global\/)?(?:category|product|knowledge-base)\/[^\s?"']+)/i;
  const ENDING_IN_URL_RE = /[?&]ending=([A-Za-z0-9]+)(?:&|$)/i;
  const LABEL_PAIR_RE    = /\b([A-Za-zÅÄÖåäö][A-Za-zÅÄÖåäö0-9]+)\s+([a-z0-9-]{3,})\b/;
  const QUIZ_SHORT_RE    = /quiz-(young|snaffle|leverage)-\d+/i;

  for (const raw of deepStrings(fr)) {
    const s = String(raw);

    if (!foundPath) {
      const u = s.match(PATH_IN_URL_RE);
      if (u) foundPath = normalizeQuizPath(u[1]);
    }
    if (!foundPath) {
      const p = s.match(PLAIN_PATH_RE);
      if (p) foundPath = normalizeQuizPath(p[1]);
    }
    if (!foundEnding) {
      const e = s.match(ENDING_IN_URL_RE);
      if (e) foundEnding = e[1];
    }

    if (!foundPath) {
      const m = s.match(LABEL_PAIR_RE);
      if (m && m[2]?.includes("-")) {
        const slug = m[2].toLowerCase();
        if (QUIZ_SHORT_RE.test(slug)) {
          foundPath = normalizeQuizPath(`category/${slug}`);
        } else {
          foundPath = normalizeQuizPath(`product/${slug}`);
        }
        if (!foundEnding) foundEnding = m[1];
      }
    }

    if (!foundPath) {
      const q = s.match(QUIZ_SHORT_RE);
      if (q) foundPath = normalizeQuizPath(`category/${q[0].toLowerCase()}`);
    }

    if (foundPath && foundEnding) break;
  }

  return { foundPath, foundEnding };
}

/* ---------- Profile helpers (create/resolve, tolerate 409) ---------- */

async function getOrCreateProfileId(email) {
  try {
    const resp = await kpost(`${KLAVIYO_API_BASE}/profiles/`, {
      data: { type: "profile", attributes: { email } },
    });
    const txt = await resp.text().catch(() => "");
    if (resp.ok) {
      try { return JSON.parse(txt)?.data?.id || null; } catch { return null; }
    }
    if (resp.status === 409) {
      try {
        const err   = JSON.parse(txt);
        const dupId = err?.errors?.[0]?.meta?.duplicate_profile_id;
        if (dupId) return dupId;
      } catch {}
      return await findProfileIdByEmail(email);
    }
    return await findProfileIdByEmail(email);
  } catch {
    return await findProfileIdByEmail(email);
  }
}

async function findProfileIdByEmail(email) {
  try {
    const filter = encodeURIComponent(`equals(email,"${email}")`);
    const resp   = await kget(`${KLAVIYO_API_BASE}/profiles/?filter=${filter}`);
    if (!resp.ok) return null;
    const j = await resp.json().catch(() => ({}));
    return j?.data?.[0]?.id || null;
  } catch {
    return null;
  }
}
