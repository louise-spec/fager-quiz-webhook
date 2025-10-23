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

  const headers = () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("Accept", "application/json");
    h.set("Authorization", `Klaviyo-API-Key ${KLAVIYO_API_KEY}`);
    // Håll oss kvar på nyare schema där metric-id krävs i relationship:
    h.set("revision", "2024-10-15");
    return h;
  };

  // --- Hämta metric-ID genom att lista alla metrics och följa links.next
  async function findMetricIdByName(name) {
    let url = "https://a.klaviyo.com/api/metrics/"; // inga query params
    for (let page = 0; page < 50; page++) {         // säkerhetsbegränsning
      const r = await fetchJson(url, {
        method: "GET",
        headers: headers(),
        timeoutMs: 8000,
      });
      if (!r.ok) {
        console.warn("List metrics failed:", r.status, r.text?.slice(0, 400));
        return null;
      }
      const arr = r.json?.data || [];
      const hit = arr.find(
        (m) =>
          m?.attributes?.name?.toLowerCase().trim() === name.toLowerCase().trim()
      );
      if (hit?.id) return hit.id;

      const nextLink = r.json?.links?.next;
      if (!nextLink) break;
      url = nextLink; // följ serverns cursor-länk
    }
    return null;
  }

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = rawBody?.form_response || {};

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

    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;
    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // Hitta metricens ID (vi får inte skapa – bara läsa)
    const metricId = await findMetricIdByName(KLAVIYO_METRIC);
    if (!metricId) {
      console.error("Could not resolve metric id for", KLAVIYO_METRIC);
      // Svara 200 så TF inte spammar (men vi ser felet i loggarna)
      return res
        .status(200)
        .json({ ok: false, note: "Could not resolve Klaviyo metric id" });
    }

    // Bygg event – relationships.metric.data.id måste sättas
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

    console.log("Posting to Klaviyo…");
    const post = await fetchJson("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(eventBody),
      timeoutMs: 8000,
    });

    if (!post.ok) {
      console.error("Klaviyo error:", post.status, post.text?.slice(0, 800));
    } else {
      console.log("Klaviyo OK for", email, ending);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ ok: false, error: "Handler error" });
  }
}
