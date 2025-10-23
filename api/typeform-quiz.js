// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC = process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET;

  // Nyckel-koll i loggarna (maskerad)
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // (Valfritt) enkel secret-kontroll
    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // Hämta e-post
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email in submission; skipping." });
    }

    // Quiz-data
    const ending = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // 1) Hämta metric-ID för det namn vi använder (t.ex. "Filled Out Form")
    const metricId = await resolveMetricId(KLAVIYO_API_KEY, KLAVIYO_METRIC);
    if (!metricId) {
      console.error("Could not resolve metric id for", KLAVIYO_METRIC);
      return res.status(200).json({ ok: true, note: "Metric not found" });
    }

    // 2) Bygg event enligt Klaviyo relationships-spec
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
          occurred_at: submittedAt,
        },
        relationships: {
          // OBS: metric som relationship med data.id
          metric: {
            data: { type: "metric", id: metricId },
          },
          // OBS: profile som relationship med data.attributes.email
          profile: {
            data: {
              type: "profile",
              attributes: { email },
            },
          },
        },
      },
    };

    // 3) Skicka event till Klaviyo (kort timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    try {
      console.log("Posting to Klaviyo…");
      const resp = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          revision: "2023-07-15",
        },
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("Klaviyo error:", resp.status, txt?.slice(0, 500));
      } else {
        console.log("Klaviyo OK for", email, ending);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("Klaviyo fetch error:", err?.message || err);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Slår upp metric-ID från ett metr-namn via Klaviyos Metrics API.
 * Returnerar t.ex. "01HXXXXX…" eller null om inte hittat.
 */
async function resolveMetricId(apiKey, metricName) {
  const url = "https://a.klaviyo.com/api/metrics/?page[size]=100";
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: "2023-07-15",
      },
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.warn("List metrics failed:", resp.status, txt?.slice(0, 300));
      return null;
    }

    const json = await resp.json();
    const hit = (json?.data || []).find(
      (m) => m?.attributes?.name?.trim() === metricName.trim()
    );

    if (!hit) {
      console.warn("Metric not found in list:", metricName);
      return null;
    }

    return hit.id || null;
  } catch (e) {
    console.warn("List metrics exception:", e?.message || e);
    return null;
  }
}
