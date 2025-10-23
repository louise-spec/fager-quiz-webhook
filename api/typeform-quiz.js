// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC =
    process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET; // (valfri – används ej här)

  // Maskerad nyckelkontroll i logg (hjälper felsökning i Vercel Logs)
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );
  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
  }

  try {
    // Typeform skickar JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // --- Plocka ut e-post
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email found, skipping Klaviyo send.");
      return res
        .status(200)
        .json({ ok: true, note: "No email in submission; skipping." });
    }

    // --- Quiz-data
    const ending = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // --- Se till att vi har ett metric-id (hämta → annars skapa)
    let metricId = null;
    try {
      metricId = await ensureMetricId(KLAVIYO_API_KEY, KLAVIYO_METRIC);
      console.log("Metric OK:", KLAVIYO_METRIC, "id:", metricId);
    } catch (e) {
      console.error("Failed to ensure metric id:", e?.message || e);
      // Vi försöker ändå — men event-post kräver id, så sannolikt blir det 400 annars.
    }

    // --- Event enligt v2023-07-15 schema
    //    relationships.metric.id MÅSTE skickas; profile läggs i relationships.profile
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name: quizName,
            quiz_result: ending,
            source,
            submitted_at: submittedAt,
          },
          time: submittedAt, // Klaviyo fältet heter "time" i den här versionen
        },
        relationships: {
          metric: {
            data: { type: "metric", id: metricId }, // <-- viktigt!
          },
          profile: {
            data: {
              type: "profile",
              attributes: { email },
            },
          },
        },
      },
    };

    // --- Posta med timeout + 1 retry
    try {
      console.log("Posting to Klaviyo… metricId:", metricId);
      await postToKlaviyoWithRetry(KLAVIYO_API_KEY, eventBody);
      console.log("Klaviyo OK for", email, ending);
    } catch (err) {
      console.error("Klaviyo error:", err?.message || err);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ======================== Hjälpare ======================== */

function baseHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: "2023-07-15",
  };
}

// Hämtar metric-listan och letar efter rätt namn (Klaviyo låter inte filtrera på name)
async function getMetricByName(apiKey, metricName) {
  const url = "https://a.klaviyo.com/api/metrics?fields[metric]=name";
  const resp = await fetch(url, {
    method: "GET",
    headers: baseHeaders(apiKey),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`GET metrics failed ${resp.status}: ${t?.slice(0, 200)}`);
  }

  const json = await resp.json();
  const found = json?.data?.find(
    (m) => m?.attributes?.name?.toLowerCase() === metricName.toLowerCase()
  );
  return found || null;
}

async function createMetric(apiKey, metricName) {
  const url = "https://a.klaviyo.com/api/metrics";
  const payload = {
    data: {
      type: "metric",
      attributes: { name: metricName },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: baseHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Create metric failed ${resp.status}: ${t?.slice(0, 200)}`);
  }

  const json = await resp.json();
  return json?.data?.id;
}

async function ensureMetricId(apiKey, metricName) {
  const existing = await getMetricByName(apiKey, metricName);
  if (existing?.id) return existing.id;
  // Finns inte — skapa
  return await createMetric(apiKey, metricName);
}

async function postToKlaviyoWithRetry(apiKey, eventBody) {
  const url = "https://a.klaviyo.com/api/events/";
  const maxRetries = 1; // 1 retry (2 försök totalt)
  const timeoutMs = 5000; // 5s per försök

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: baseHeaders(apiKey),
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${txt?.slice(0, 300)}`);
      }
      return; // success
    } catch (err) {
      clearTimeout(timer);
      console.error(`Klaviyo fetch error attempt ${attempt}:`, err?.message || err);
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500)); // liten backoff
    }
  }
}
