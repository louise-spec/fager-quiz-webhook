// api/typeform-webhook.js (Vercel/Next.js serverless)
// Funktion: Upserta Klaviyo-profil OCH spara en historik (quiz_history) med alla quiz som en person gjort
// Kräver env-variabler: KLAVIYO_API_KEY (Private key), KLAVIYO_REVISION (t.ex. "2024-07-15")

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // 1) Läs ut fält från Typeform (anpassa mappning efter din payload)
    const {
      email,
      horse_name,
      ending_title, // t.ex. "Sensitive Mouth"
      ending_key,   // t.ex. "quiz-young-2"
      quiz_path,    // t.ex. "global/category/quiz-young-2"
      quiz_name = 'Fager Quiz',
      source = 'typeform'
    } = normalizeTypeformPayload(req.body);

    if (!email) return res.status(400).json({ error: 'Missing email' });

    // 2) Hämta/Skapa profil
    const profile = await findOrCreateProfileByEmail({ email });

    // 3) Bygg en ny historikpost
    const nowISO = new Date().toISOString();
    const newEntry = {
      date: nowISO,
      horse: horse_name || null,
      ending: ending_title || null,
      ending_key: ending_key || null,
      quiz_path: quiz_path || null,
      quiz_name,
      source
    };

    // 4) Hämta befintlig quiz_history och append:a
    const currentProps = profile?.attributes?.properties || {};
    const history = Array.isArray(currentProps.quiz_history) ? [...currentProps.quiz_history] : [];

    // (valfritt) Dedupe per (horse, ending_key, date dag)
    history.unshift(newEntry); // lägg senaste först

    // (valfritt) Begränsa till max 50 poster
    const trimmed = history.slice(0, 50);

    // 5) Uppdatera profilen: spara senaste quizet + full historik
    const propertiesPatch = {
      // "Senaste" fält (enkla att använda i e-post)
      horse_name,
      ending_title,
      ending_key,
      quiz_path,
      quiz_name,
      source,
      // Full historik
      quiz_history: trimmed
    };

    await patchProfileProperties(profile.id, propertiesPatch);

    // 6) (Valfritt) Skicka event för att trigga Flow i Klaviyo
    await sendEventToKlaviyo({
      metric_name: 'Fager Quiz Completed',
      email,
      properties: {
        horse_name,
        ending_title,
        ending_key,
        quiz_path,
        quiz_name,
        source
      }
    });

    return res.status(200).json({ ok: true, profile_id: profile.id, appended: newEntry });
  } catch (err) {
    console.error('Webhook error', err);
    return res.status(500).json({ error: 'Internal error', details: String(err?.message || err) });
  }
}

/** ------------------------------------------------------
 * Helpers: Klaviyo Profiles API (v2024-xx-xx)
 * ------------------------------------------------------ */
const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api';

function headers() {
  const revision = process.env.KLAVIYO_REVISION || '2024-07-15';
  return {
    'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Revision': revision
  };
}

async function findOrCreateProfileByEmail({ email }) {
  // Försök hitta profilen via filter på email
  const q = encodeURIComponent(`equals(email,"${email}")`);
  const url = `${KLAVIYO_API_BASE}/profiles/?filter=${q}`;
  const resp = await fetch(url, { headers: headers() });
  if (!resp.ok) throw new Error(`Profiles search failed: ${resp.status}`);
  const data = await resp.json();
  const existing = data?.data?.[0];
  if (existing) return existing; // redan befintlig profil

  // Skapa om den inte finns
  const createBody = {
    data: {
      type: 'profile',
      attributes: {
        email
      }
    }
  };
  const create = await fetch(`${KLAVIYO_API_BASE}/profiles/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(createBody)
  });
  if (!create.ok) throw new Error(`Profile create failed: ${create.status}`);
  return await create.json().then(x => x.data);
}

async function patchProfileProperties(profileId, properties) {
  const body = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: {
        properties
      }
    }
  };
  const resp = await fetch(`${KLAVIYO_API_BASE}/profiles/${profileId}/`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Profile patch failed: ${resp.status} ${text}`);
  }
}

/** ------------------------------------------------------
 * (Valfritt) Skicka event för Flow-trigger
 * - Om du redan har en fungerande event-postning: behåll den.
 * - Den här versionen använder Klaviyos "Track"-stil endpoint för enkelhet.
 *   Vill du byta till nya Events API kan du plugga in din befintliga funktion här.
 * ------------------------------------------------------ */
async function sendEventToKlaviyo({ metric_name, email, properties }) {
  try {
    // Enkel track via /api/events/ (ersätt med din befintliga om du har)
    const body = {
      data: {
        type: 'event',
        attributes: {
          metric: { name: metric_name },
          properties,
          profile: { data: { type: 'profile', attributes: { email } } },
          time: new Date().toISOString()
        }
      }
    };
    const resp = await fetch(`${KLAVIYO_API_BASE}/events/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.warn('Event post non-OK', resp.status, t);
    }
  } catch (e) {
    console.warn('Event post error', e);
  }
}

/** ------------------------------------------------------
 * Mappning: Typeform → fält
 * Anpassa så att email/ending/etc. hamnar rätt.
 * ------------------------------------------------------ */
function normalizeTypeformPayload(payload) {
  // Robust mapping for raw Typeform webhook OR pre-transformed JSON
  const direct = (k) => payload?.[k] ?? payload?.[k?.toLowerCase?.()] ?? null;
  const hidden = payload?.form_response?.hidden || {};
  const answers = payload?.form_response?.answers || [];

  const byRef = (ref) => {
    if (!ref) return null;
    const a = answers.find(x => x?.field?.ref === ref);
    return extractAnswerValue(a);
  };
  const byType = (t) => extractAnswerValue(answers.find(x => x?.type === t));

  // Helper: first free-text answer that isn't the email question
  const firstNonEmailText = () => {
    const a = answers.find(x => x?.type === 'text' && !x?.email);
    return extractAnswerValue(a);
  };

  const email = direct('email') || hidden.email || byRef('email') || byType('email');

  // Try labeled/hidden first, then smart guess by question wording, finally fallback to first free-text
  let horse_name = direct('horse_name')
    || hidden.horse_name
    || byRef('horse_name')
    || guessByLabel(answers, ['horse', 'häst', 'hästens namn', 'horse name']);

  if (!horse_name) horse_name = firstNonEmailText();

  const ending_title = direct('ending_title')
    || hidden.ending_title
    || byRef('ending_title')
    || guessByLabel(answers, ['ending title', 'result', 'slut', 'resultat']);

  const ending_key = direct('ending_key') || hidden.ending_key || byRef('ending_key');
  const quiz_path  = direct('quiz_path')  || hidden.quiz_path  || byRef('quiz_path');
  const quiz_name  = direct('quiz_name')  || hidden.quiz_name  || byRef('quiz_name') || 'Fager Quiz';
  const source     = direct('source')     || hidden.source     || byRef('source')    || 'typeform';

  // Debug log (safe): helps verify the mapping during tests
  try { console.log('🧪 Detected horse_name:', horse_name || '(none)'); } catch {}

  return { email, horse_name, ending_title, ending_key, quiz_path, quiz_name, source };
}

function extractAnswerValue(a) {
  if (!a) return null;
  // Typeform svarstyper vi bryr oss om
  if (a.email) return a.email;
  if (a.text) return a.text;
  if (a.choice?.label) return a.choice.label;
  if (typeof a.number === 'number') return a.number;
  if (a.boolean === true || a.boolean === false) return a.boolean;
  if (a.date) return a.date; // YYYY-MM-DD
  return null;
}

function guessByLabel(answers, keywords) {
  const lower = (s) => (s || '').toString().toLowerCase();
  const match = answers.find(a => keywords.some(k => lower(a?.field?.ref).includes(lower(k)) || lower(a?.field?.id).includes(lower(k)) || lower(a?.field?.title).includes(lower(k))));
  return extractAnswerValue(match);
}

function getAnswer(payload, ref) {
  // Om `payload.form_response.answers`-struktur används (ren Typeform)
  try {
    const answers = payload?.form_response?.answers || [];
    const fld = answers.find(a => a.field?.ref === ref);
    if (!fld) return null;
    return fld.email || fld.text || fld.choice?.label || fld.number || null;
  } catch {
    return null;
  }
}
