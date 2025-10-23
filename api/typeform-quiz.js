// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Env
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET; // (valfritt att verifiera webhookens signatur)
  const KLAVIYO_METRIC_NAME =
    process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  // Maskerad nyckelkontroll i loggen (visas i Vercel Runtime Logs)
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  try {
    // ---- Läs Typeform JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // ---- Plocka email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      return res
        .status(200)
        .json({ ok: true, note: "No email in submission; skipping." });
    }

    // ---- Quizdata
    const ending = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // ---- Hämta (eller skapa) metric-ID till Klaviyo
    let metricId;
    try {
      metricId = await ensureMetricId(KLAVIYO_API_KEY, KLAVIYO_METRIC_NAME);
    } catch (e) {
      console.error("Failed to ensure metric id:", e?.message || e);
      // svara 200 till Typeform ändå så de inte loopar om
      return res.status(200).json({ ok: true, note: "Metric lookup failed" });
    }

    // ---- Bygg event payload enligt v2023-07-15 (relationships.metric -> id)
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
          profile: { email },
          occurred_at: submittedAt,
        },
        relationships: {
          metric: {
            data: { type: "metric", id: metricId },
          },
        },
      },
    };

    // ---- Skicka till Klaviyo och vänta svar
    try {
      console.log("Posting to Klaviyo… metricId:", metricId);
      await postToKlaviyoWithRetry(eventBody, KLAVIYO_API_KEY);
      console.log("Klaviyo OK for", email, ending);
    } catch (err) {
      console.error("Klaviyo error:", err?.message || err);
      // svara ändå 200 så Typeform inte spammar retrys
      return res.status(200).json({ ok: true, note: "Klaviyo error logged" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Hämta metric-id via namn; skapa den om den inte finns.
 */
async function ensureMetricId(apiKey, metricName) {
  // 1) Försök hitta metricen
  const found = await getMetricByName(apiKey, metricName);
  if (found?.id) return found.id;

  // 2) Skapa den om den saknas
  const created = await createMetric(apiKey, metricName);
  if (!created?.id) throw new Error("Failed to create metric");
  return created.id;
}

async function getMetricByName(apiKey, metricName) {
  // Klaviyos filter syntax i nya API:t:
  //   filter=equals(name,"Fager Bit Quiz Completed")
  const url =
    "https://a.klaviyo.com/api/metrics?filter=" +
    encodeURIComponent(`equals(name,"${metricName}")`);

  const resp = await fetch(url, {
    method: "GET",
    headers: baseHeaders(apiKey),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`GET metrics failed ${resp.status}: ${t?.slice(0, 200)}`);
  }

  const json = await resp.json();
  const first = json?.data?.[0];
  return first || null;
}

async function createMetric(apiKey, metricName) {
  const url = "https://a.klaviyo.com/api/metrics/";
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

  return await resp.json().then((j) => j?.data);
}

/**
 * Skicka event med timeout + enkel retry.
 */
async function postToKlaviyoWithRetry(eventBody, apiKey) {
  const url = "https://a.klaviyo.com/api/events/";
  const maxRetries = 1; // totalt 2 försök
  const timeoutMs = 5000;

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
        throw new Error(`HTTP ${resp.status} ${txt?.slice(0, 200)}`);
      }

      return; // success
    } catch (err) {
      clearTimeout(timer);
      console.error(`Klaviyo fetch error attempt ${attempt}:`, err?.message || err);
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

function baseHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    // Den här revisionen matchar nya API:t som kräver relationships.metric.id
    revision: "2023-07-15",
  };
}
