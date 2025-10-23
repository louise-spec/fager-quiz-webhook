// api/typeform-quiz.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const METRIC_ID_ENV = process.env.KLAVIYO_METRIC_ID || "";
  const METRIC_NAME = process.env.KLAVIYO_METRIC || "Filled Out Form";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  // Hjälpsam maskerad logg
  console.log(
    "Key check:",
    (KLAVIYO_API_KEY || "").length,
    "chars; last4:",
    (KLAVIYO_API_KEY || "").slice(-4)
  );

  if (!KLAVIYO_API_KEY) {
    console.error("Missing KLAVIYO_API_KEY");
    return res.status(200).json({ ok: true, note: "Missing API key" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // (Valfritt) enkel secret-validering om du satt secret i Typeform
    if (TYPEFORM_SECRET) {
      const sentSecret =
        body?.secret ||
        body?.form_response?.hidden?.secret ||
        body?.form_response?.hidden?.Secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    // 1) Plocka e-post
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

    // 2) Övriga properties vi vill spara på eventet
    const ending =
      fr?.calculated?.outcome?.title || fr?.hidden?.ending || "unknown";
    const quizName = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // 3) Hitta metric-ID (använd env om satt; annars lista metrics och leta namn)
    let metricId = METRIC_ID_ENV;
    if (!metricId) {
      try {
        metricId = await resolveMetricIdByName({
          name: METRIC_NAME,
          apiKey: KLAVIYO_API_KEY,
        });
      } catch (e) {
        console.warn("Failed to resolve metric id by name:", e?.message || e);
      }
    }
    if (!metricId) {
      console.error(
        `Could not resolve metric id for ${METRIC_NAME}. Set KLAVIYO_METRIC_ID env to avoid lookup.`
      );
      return res.status(200).json({
        ok: true,
        note: `Could not resolve metric id for ${METRIC_NAME}`,
      });
    }

    // 4) Bygg event enligt JSON:API (2023-07-15)
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          // "time" eller "occurred_at" – Klaviyo accepterar "time"
          time: submittedAt,
          properties: {
            quiz_name: quizName,
            quiz_result: ending,
            source,
            submitted_at: submittedAt,
          },
        },
        relationships: {
          metric: {
            data: { type: "metric", id: metricId },
          },
          profile: {
            // Använd Klaviyos special-ID för e-post
            data: { type: "profile", id: `$email:${email}` },
          },
        },
      },
    };

    // 5) POST event
    try {
      console.log("Posting to Klaviyo… metricId:", metricId);
      const resp = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          revision: "2023-07-15",
        },
        body: JSON.stringify(eventBody),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("Klaviyo error:", resp.status, txt?.slice(0, 400));
      } else {
        console.log("Klaviyo OK for", email, ending);
      }
    } catch (err) {
      console.error("Klaviyo fetch error:", err?.message || err);
    }

    // Svara 200 till Typeform oavsett
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ ok: true, note: "handler error" });
  }
}

/**
 * Hitta metric-ID via namn, med pagination (page[size], links.next]).
 * Returnerar tom sträng om inte hittad.
 */
async function resolveMetricIdByName({ name, apiKey }) {
  let url = "https://a.klaviyo.com/api/metrics/?page[size]=100";

  for (let i = 0; i < 20 && url; i++) {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: "2023-07-15",
      },
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn("List metrics failed:", r.status, t?.slice(0, 400));
      return "";
    }

    const json = await r.json();
    const found = (json?.data || []).find(
      (m) => m?.attributes?.name?.trim() === name
    );
    if (found?.id) return found.id;

    url = json?.links?.next || "";
  }

  return "";
}
