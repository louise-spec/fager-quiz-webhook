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
ending_key, // t.ex. "quiz-young-2"
quiz_path, // t.ex. "global/category/quiz-young-2"
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
