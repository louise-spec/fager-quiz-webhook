// /api/typeform-quiz.js
// Fager Quiz → Klaviyo metric (ID: VqXtMg)
// Hanterar alla endings, fallback, Typeform-test & robust logging.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_METRIC_ID = process.env.KLAVIYO_METRIC_ID || "VqXtMg";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  // === Endings (full lista från Fager Bits) ===
  const ENDING_LOOKUP = {
    "john linus": "john_linus", "johnlinus": "john_linus",
    "axel carter": "axel_carter", "axelcarter": "axel_carter",
    "emil laura": "emil_laura", "emillaura": "emil_laura",
    "gustav greta": "gustav_greta", "gustavgreta": "gustav_greta",
    "harry nicole": "harry_nicole", "harrynicole": "harry_nicole",
    "gabriel julia mats": "gabriel_julia_mats", "gabrieljuliamats": "gabriel_julia_mats",
    "john conny linus": "john_conny_linus", "johnconnylinus": "john_conny_linus",
    "simon nils": "simon_nils", "simonnils": "simon_nils",
    "fredric emil annie laura": "fredric_emil_annie_laura", "fredricemilannielaurA": "fredric_emil_annie_laura",
    "emil annie laura": "emil_annie_laura", "emilannielaurA": "emil_annie_laura",
    "harry niklas": "harry_niklas", "harryniklas": "harry_niklas",
    "oscar mia": "oscar_mia", "oscarmia": "oscar_mia",
    "nikita harriet": "nikita_harriet", "nikitaharriet": "nikita_harriet",
    "nina sara olivia": "nina_sara_olivia", "ninasaraolivia": "nina_sara_olivia",
    "mattias gustav nils": "mattias_gustav_nils", "mattiasgustavnils": "mattias_gustav_nils",
    "anna martin michael": "anna_martin_michael", "annamartinmichael": "anna_martin_michael",
    "matilda nina greta": "matilda_nina_greta", "matildaninagreta": "matilda_nina_greta",
    "bianca wilma thilde": "bianca_wilma_thilde", "biancawilmathilde": "bianca_wilma_thilde",
    "dylan marcus": "dylan_marcus", "dylanmarcus": "dylan_marcus",
    "emilia thilde": "emilia_thilde", "emiliathilde": "emilia_thilde",
    "ginny sally maja": "ginny_sally_maja", "ginnysallymaja": "ginny_sally_maja",
    "hanna fanny": "hanna_fanny", "hannafanny": "hanna_fanny",
    "harald felix": "harald_felix", "haraldfelix": "harald_felix",
    "hilda maria": "hilda_maria", "hildamaria": "hilda_maria",
    "elias tim": "elias_tim", "eliastim": "elias_tim",
    "jack walter tim": "jack_walter_tim", "jackwaltertim": "jack_walter_tim",
    "owen valerie": "owen_valerie", "owenvalerie": "owen_valerie",
    "owen valeriefinnsejmedfastaringar": "owen_valerie_finns_ej_med_fasta_ringar",
    "axel annika": "axel_annika", "axelannika": "axel_annika",
    "axel annikafinnsejmedfastaringar": "axel_annika_finns_ej_med_fasta_ringar",
    "carter carina": "carter_carina", "cartercarina": "carter_carina",
    "carter carinafinnsejmedfastaringar": "carter_carina_finns_ej_med_fasta_ringar",
    "nicole soft nicole hard": "nicole_soft_nicole_hard", "nicolesoftnicolehard": "nicole_soft_nicole_hard",
    "andrea soft andrea hard": "andrea_soft_andrea_hard", "andreasoftandreahard": "andrea_soft_andrea_hard",
    "adam": "adam",
    "amanda linnea": "amanda_linnea", "amandalinnea": "amanda_linnea",
    "anna martin": "anna_martin", "annamartin": "anna_martin",
    "john": "john",
    "marcus": "marcus",
    "gustav": "gustav",
    "sally": "sally",
    "maria": "maria",
    "mattias nils": "mattias_nils", "mattiasnils": "mattias_nils",
    "julia": "julia",
    "combination bit guide": "combination_bit_guide", "combinationbitguide": "combination_bit_guide",
    "victor sweet iron weymouth": "victor_sweet_iron_weymouth", "victorsweetironweymouth": "victor_sweet_iron_weymouth",
    "victoria titanium weymouth": "victoria_titanium_weymouth", "victoriatitaniumweymouth": "victoria_titanium_weymouth",
    "nicole hard rubber bit weymouth": "nicole_hard_rubber_bit_weymouth", "nicolehardrubberbitweymouth": "nicole_hard_rubber_bit_weymouth",
    "nicole soft rubber bit weymouth": "nicole_soft_rubber_bit_weymouth", "nicolesoftrubberbitweymouth": "nicole_soft_rubber_bit_weymouth",
    "andrea hard rubber bit weymouth": "andrea_hard_rubber_bit_weymouth", "andreahardrubberbitweymouth": "andrea_hard_rubber_bit_weymouth",
    "andrea soft rubber bit weymouth": "andrea_soft_rubber_bit_weymouth", "andreasoftrubberbitweymouth": "andrea_soft_rubber_bit_weymouth",
    "lincoln sweet gold weymouth": "lincoln_sweet_gold_weymouth",
    "sofia titanium weymouth": "sofia_titanium_weymouth",
    "sebastian sweet iron weymouth": "sebastian_sweet_iron_weymouth",
    "philip sweet iron weymouth": "philip_sweet_iron_weymouth",
    "felicia titanium weymouth": "felicia_titanium_weymouth",
    "diana titanium weymouth": "diana_titanium_weymouth",
    "daniel sweet iron weymouth": "daniel_sweet_iron_weymouth",
    "charlotte titanium weymouth": "charlotte_titanium_weymouth",
    "charles sweet iron weymouth": "charles_sweet_iron_weymouth",
    "elin sweet gold bradoon loose rings": "elin_sweet_gold_bradoon_loose_rings",
    "elin sweet gold bradoon fixed rings": "elin_sweet_gold_bradoon_fixed_rings",
    "vendela titanium bradoon loose rings": "vendela_titanium_bradoon_loose_rings",
    "vendela titanium bradoon fixed rings": "vendela_titanium_bradoon_fixed_rings",
    "stephanie titanium bradoon loose rings": "stephanie_titanium_bradoon_loose_rings",
    "stephanie titanium bradoon fixed rings": "stephanie_titanium_bradoon_fixed_rings",
    "oliver sweet iron bradoon loose rings": "oliver_sweet_iron_bradoon_loose_rings",
    "oliver sweet iron bradoon fixed rings": "oliver_sweet_iron_bradoon_fixed_rings",
    "milton sweet iron bradoon loose rings": "milton_sweet_iron_bradoon_loose_rings",
    "milton sweet iron bradoon fixed rings": "milton_sweet_iron_bradoon_fixed_rings",
    "mary titanium bradoon loose rings": "mary_titanium_bradoon_loose_rings",
    "mary titanium bradoon fixed rings": "mary_titanium_bradoon_fixed_rings",
    "ludwig sweet iron bradoon loose rings": "ludwig_sweet_iron_bradoon_loose_rings",
    "ludwig sweet iron bradoon fixed rings": "ludwig_sweet_iron_bradoon_fixed_rings",
    "jesper sweet iron bradoon loose rings": "jesper_sweet_iron_bradoon_loose_rings",
    "jesper sweet iron bradoon fixed rings": "jesper_sweet_iron_bradoon_fixed_rings",
    "jenny sweet iron bradoon loose rings": "jenny_sweet_iron_bradoon_loose_rings",
    "jenny sweet iron bradoon fixed rings": "jenny_sweet_iron_bradoon_fixed_rings",
    "jasmine titanium bradoon loose rings": "jasmine_titanium_bradoon_loose_rings",
    "jasmine titanium bradoon fixed rings": "jasmine_titanium_bradoon_fixed_rings",
    "celice sweet gold bradoon loose rings": "celice_sweet_gold_bradoon_loose_rings",
    "celice sweet gold bradoon fixed rings": "celice_sweet_gold_bradoon_fixed_rings",
  };

  // === Helper functions ===
  const slugify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown";

  const toEndingKey = (title) => {
    const raw = String(title || "").trim();
    if (!raw) return "unknown";
    const lower = raw.toLowerCase();
    return ENDING_LOOKUP[lower] || ENDING_LOOKUP[lower.replace(/[\s-]+/g, "")] || slugify(raw);
  };

  const SEEN_UNKNOWN = new Set();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const fr = body?.form_response || {};

    // === Skip Typeform test requests ===
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    if (TYPEFORM_SECRET) {
      const sentSecret = body?.secret || fr?.hidden?.secret;
      if (sentSecret && sentSecret !== TYPEFORM_SECRET) {
        console.warn("⚠️ Typeform secret mismatch – ignoring");
        return res.status(200).json({ ok: true, note: "Secret mismatch" });
      }
    }

    if (isTypeformTest) {
      console.log("🧪 Typeform test payload – skipping Klaviyo");
      return res.status(200).json({ ok: true, note: "Typeform test – skipped Klaviyo" });
    }

    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = toEndingKey(endingTitle);
    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // === Logga nya endings ===
    if (!Object.values(ENDING_LOOKUP).includes(ending_key) && !ENDING_LOOKUP[endingTitle?.toLowerCase?.()]) {
      const k = `${endingTitle} -> ${ending_key}`;
      if (!SEEN_UNKNOWN.has(k)) {
        SEEN_UNKNOWN.add(k);
        console.warn("💡 Ny/omappad ending upptäckt:", k);
      }
    }

    // === Klaviyo event ===
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          properties: {
            quiz_name,
            ending_key,
            ending_title: endingTitle,
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token,
          },
          occurred_at: submittedAt,
        },
        relationships: {
          metric: { data: { type: "metric", id: KLAVIYO_METRIC_ID } },
          profile: { data: { type: "profile", id: `$email:${email}` } },
        },
      },
    };

    const resp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-10-15",
      },
      body: JSON.stringify(eventBody),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("❌ Klaviyo error:", resp.status, txt?.slice(0, 1000));
      return res.status(200).json({ ok: false, upstream: "klaviyo", status: resp.status });
    }

    console.log("✅ Klaviyo OK", { email, ending_key, metric: KLAVIYO_METRIC_ID });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
