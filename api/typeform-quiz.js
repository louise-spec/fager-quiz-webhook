// api/typeform-quiz.js

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const txt = await resp.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (_) {}
    return { ok: resp.ok, status: resp.status, text: txt, json: data };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC =
    process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET;

  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  if (!KLAVIYO_API_KEY) {
    return res.status(500).json({ error: "Missing KLAVIYO_API_KEY" });
  }

  // --- Headers helper (Klaviyo v2024)
  const headers = () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("Accept", "application/json");
    h.set("Authorization", `Klaviyo-API-Key ${KLAVIYO_API_KEY}`);
    // Nyare revision – kräver metric-id i relationship
    h.set("revision", "2024-10-15");
    return h;
  };

  // --- Ensure we have a Metric ID (create or find)
  async function ensureMetricIdByName(name) {
    // 1) Try create
    try {
      const createBody = {
        data: { type: "metric", attributes: { name } },
      };
      const r = await fetchJson("https://a.klaviyo.com/api/metrics/", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(createBody),
        timeoutMs: 8000,
      });
      if (r.ok && r.json?.data?.id) {
        console.log("Metric created:", r.json.data.id);
        return r.json.data.id;
      }
      // If create failed, we’ll fall back to search
      console.warn("Create metric failed:", r.status, r.text?.slice(0, 400));
    } catch (e) {
      console.warn("Create metric error:", e?.message || e);
    }

    // 2) List+paging until we find matching name
    let cursor = null;
    for (let page = 0; page < 20; page++) { // safety cap
      const url =
        "https://a.klaviyo.com/api/metrics/?" +
        new URLSearchParams({
          "page[size]": "100",
          ...(cursor ? { "page[cursor]": cursor } : {}),
        }).toString();

      const r = await fetchJson(url, {
        method: "GET",
        headers: headers(),
        timeoutMs: 8000,
      });

      if (!r.ok) {
        console.warn("List metrics failed:", r.status, r.text?.slice(0, 400));
        break;
      }

      const arr = r.json?.data || [];
      const hit = arr.find(
        (m) =>
          m?.attributes?.name?.toLowerCase().trim() === name.toLowerCase().trim()
      );
      if (hit?.id) {
        console.log("Metric found:", hit.id);
        return hit.id;
      }

      cursor = r.json?.links?.next ?? null;
      if (!cursor) break;
    }

    return null; // not found
  }

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = rawBody?.form_response || {};

    // Optional Typeform secret check
    if (TYPEFORM_SECRET) {
      const sentSecret =
        rawBody?.secret ||
        rawBody?.form_response?.hidden?.secret ||
        rawBody?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // Extract email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Quiz properties
    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // --- Get/ensure metric id
    const metricId = await ensureMetricIdByName(KLAVIYO_METRIC);
    if (!metricId) {
      console.error("Could not resolve metric id for", KLAVIYO_METRIC);
      // Svara 200 så TF inte spammar (men lämna loggarna!)
      return res
        .status(200)
        .json({ ok: false, note: "Could not resolve Klaviyo metric id" });
    }

    // --- Build event payload with RELATIONSHIP metric.id
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
            data: {
              type: "metric",
              id: metricId,
            },
          },
        },
      },
    };

    // --- POST event
    console.log("Posting to Klaviyo…");
    const r = await fetchJson("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(eventBody),
      timeoutMs: 8000,
    });

    if (!r.ok) {
      console.error("Klaviyo error:", r.status, r.text?.slice(0, 800));
    } else {
      console.log("Klaviyo OK for", email, ending);
    }

    // Svara alltid 200 till Typeform för att undvika retry-storm
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ ok: false, error: "Handler error" });
  }
}
