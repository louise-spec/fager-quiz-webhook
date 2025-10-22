export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET;
  const KLAVIYO_METRIC = process.env.KLAVIYO_METRIC || "Fager Bit Quiz Completed";

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // Hämta e-postadress
    const email =
      (fr.answers || []).find((a) => a.type === "email")?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("No email found, skipping Klaviyo send.");
      return res
        .status(200)
        .json({ ok: true, note: "No email in submission, skipping." });
    }

    // Hämta quiz-data
    const ending =
      fr.calculated?.outcome?.title ||
      fr.hidden?.ending ||
      "unknown";
    const quizName =
      fr.hidden?.quiz_name || "FagerBitQuiz";
    const source =
      fr.hidden?.source || "Website";
    const submittedAt =
      fr.submitted_at || new Date().toISOString();

    // Skicka 200 direkt till Typeform så den inte väntar
    res.status(200).json({ ok: true });

    // ====== HJÄLPFUNKTION FÖR RETRY + TIMEOUT ======
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function postToKlaviyo(
      url,
      opts,
      { retries = 2, timeoutMs = 10000 } = {}
    ) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        try {
          const r = await fetch(url, { ...opts, signal: controller.signal });
          clearTimeout(timer);
          if (r.ok) return r;
          const txt = await r.text().catch(() => "");
          console.error("Klaviyo non-200", r.status, txt);
          if (r.status >= 400 && r.status < 500) return r; // 4xx = ingen retry
        } catch (e) {
          console.error(
            `Klaviyo fetch error attempt ${attempt} after ${
              Date.now() - start
            }ms:`,
            e?.message || e
          );
        }
        await sleep(500 * Math.pow(2, attempt)); // 0.5s, 1s, 2s backoff
      }
      throw new Error("Klaviyo fetch failed after retries");
    }

    // ====== SKICKA TILL KLAVIYO ======
    queueMicrotask(async () => {
      try {
        if (!KLAVIYO_API_KEY) throw new Error("Missing KLAVIYO_API_KEY");

        const eventBody = {
          data: {
            type: "event",
            attributes: {
              metric: { name: KLAVIYO_METRIC },
              properties: {
                quiz_name: quizName,
                quiz_result: ending,
                source,
                submitted_at: submittedAt,
              },
              profile: { email },
              occurred_at: submittedAt,
            },
          },
        };

        const resp = await postToKlaviyo(
          "https://a.klaviyo.com/api/events/",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
              revision: "2023-07-15",
            },
            body: JSON.stringify(eventBody),
          },
          { retries: 2, timeoutMs: 10000 }
        );

        if (resp?.ok) {
          console.log("Klaviyo OK for", email, ending);
        } else {
          console.warn("Klaviyo responded non-OK for", email);
        }
      } catch (err) {
        console.error("Background error:", err);
      }
    });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
