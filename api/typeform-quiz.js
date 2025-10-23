// /api/typeform-quiz.js
// Fager Quiz → Klaviyo via metric by name (kompatibelt schema)
// - INTE relationships.metric/profile (undviker "'metric' is not an allowed relation")
// - revision 2024-06-15
// - mapping av endings + slugify-fallback
// - hanterar Typeform "Send test request" (returnerar 200)
// - loggar nya endings (utan att spamma)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // === Env ===
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  // Unikt metr-namn för quizet (skapas automatiskt vid första lyckade POST)
  const KLAVIYO_METRIC_NAME =
    process.env.KLAVIYO_METRIC_NAME || "Fager Quiz Completed";
  const TYPEFORM_SECRET = process.env.TYPEFORM_SECRET || "";

  if (!KLAVIYO_API_KEY) {
    console.error("❌ Missing KLAVIYO_API_KEY");
    return res.status(500).json({ error: "Server not configured" });
  }

  // === Kända endings (från din lista) ===
  const ENDING_LOOKUP = {
    // Young
    "john linus": "john_linus", "johnlinus": "john_linus",
    "axel carter": "axel_carter", "axelcarter": "axel_carter",
    "emil laura": "emil_laura", "emillaura": "emil_laura",
    "gustav greta": "gustav_greta", "gustavgreta": "gustav_greta",
    "harry nicole": "harry_nicole", "harrynicole": "harry_nicole",

    // Snaffle
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

    // Leverage
    "anna martin": "anna_martin", "annamartin": "anna_martin",
    "john": "john",
    "marcus": "marcus",
    "gustav": "gustav",
    "sally": "sally",
    "maria": "maria",
    "mattias nils": "mattias_nils", "mattiasnils": "mattias_nils",
    "julia": "julia",
    "axel carter": "axel_carter", // leverage-25
    "sara": "sara",
    "simon nils nilskommerseni k": "simon_nils_nilskommerseni_k",

    // Knowledge-base
    "combination bit guide": "combination_bit_guide", "combinationbitguide": "combination_bit_guide",

    // Weymouth + Bradoon produkter
    "victor sweet iron weymouth": "victor_sweet_iron_weymouth", "victorsweetironweymouth": "victor_sweet_iron_weymouth",
    "victoria titanium weymouth": "victoria_titanium_weymouth", "victoriatitaniumweymouth": "victoria_titanium_weymouth",
    "nicole hard rubber bit weymouth": "nicole_hard_rubber_bit_weymouth", "nicolehardrubberbitweymouth": "nicole_hard_rubber_bit_weymouth",
    "nicole soft rubber bit weymouth": "nicole_soft_rubber_bit_weymouth", "nicolesoftrubberbitweymouth": "nicole_soft_rubber_bit_weymouth",
    "andrea hard rubber bit weymouth": "andrea_hard_rubber_bit_weymouth", "andreahardrubberbitweymouth": "andrea_hard_rubber_bit_weymouth",
    "andrea soft rubber bit weymouth": "andrea_soft_rubber_bit_weymouth", "andreasoftrubberbitweymouth": "andrea_soft_rubber_bit_weymouth",
    "lincoln sweet gold weymouth": "lincoln_sweet_gold_weymouth", "lincolnsweetgoldweymouth": "lincoln_sweet_gold_weymouth",
    "sofia titanium weymouth": "sofia_titanium_weymouth", "sofiatitaniumweymouth": "sofia_titanium_weymouth",
    "sebastian sweet iron weymouth": "sebastian_sweet_iron_weymouth", "sebastiansweetironweymouth": "sebastian_sweet_iron_weymouth",
    "philip sweet iron weymouth": "philip_sweet_iron_weymouth", "philipsweetironweymouth": "philip_sweet_iron_weymouth",
    "felicia titanium weymouth": "felicia_titanium_weymouth", "feliciatitaniumweymouth": "felicia_titanium_weymouth",
    "diana titanium weymouth": "diana_titanium_weymouth", "dianatitaniumweymouth": "diana_titanium_weymouth",
    "daniel sweet iron weymouth": "daniel_sweet_iron_weymouth", "danielsweetironweymouth": "daniel_sweet_iron_weymouth",
    "charlotte titanium weymouth": "charlotte_titanium_weymouth", "charlottetitaniumweymouth": "charlotte_titanium_weymouth",
    "charles sweet iron weymouth": "charles_sweet_iron_weymouth", "charlessweetironweymouth": "charles_sweet_iron_weymouth",
    "elin sweet gold bradoon loose rings": "elin_sweet_gold_bradoon_loose_rings", "elinsweetgoldbradoonlooserings": "elin_sweet_gold_bradoon_loose_rings",
    "elin sweet gold bradoon fixed rings": "elin_sweet_gold_bradoon_fixed_rings", "elinsweetgoldbradoonfixedrings": "elin_sweet_gold_bradoon_fixed_rings",
    "vendela titanium bradoon loose rings": "vendela_titanium_bradoon_loose_rings", "vendelatitaniumbradoonlooserings": "vendela_titanium_bradoon_loose_rings",
    "vendela titanium bradoon fixed rings": "vendela_titanium_bradoon_fixed_rings", "vendelatitaniumbradoonfixedrings": "vendela_titanium_bradoon_fixed_rings",
    "stephanie titanium bradoon loose rings": "stephanie_titanium_bradoon_loose_rings", "stephanietitaniumbradoonlooserings": "stephanie_titanium_bradoon_loose_rings",
    "stephanie titanium bradoon fixed rings": "stephanie_titanium_bradoon_fixed_rings", "stephanietitaniumbradoonfixedrings": "stephanie_titanium_bradoon_fixed_rings",
    "oliver sweet iron bradoon loose rings": "oliver_sweet_iron_bradoon_loose_rings", "oliversweetironbradoonlooserings": "oliver_sweet_iron_bradoon_loose_rings",
    "oliver sweet iron bradoon fixed rings": "oliver_sweet_iron_bradoon_fixed_rings", "oliversweetironbradoonfixedrings": "oliver_sweet_iron_bradoon_fixed_rings",
    "milton sweet iron bradoon loose rings": "milton_sweet_iron_bradoon_loose_rings", "miltonsweetironbradoonlooserings": "milton_sweet_iron_bradoon_loose_rings",
    "milton sweet iron bradoon fixed rings": "milton_sweet_iron_bradoon_fixed_rings", "miltonsweetironbradoonfixedrings": "milton_sweet_iron_bradoon_fixed_rings",
    "mary titanium bradoon loose rings": "mary_titanium_bradoon_loose_rings", "marytitaniumbradoonlooserings": "mary_titanium_bradoon_loose_rings",
    "mary titanium bradoon fixed rings": "mary_titanium_bradoon_fixed_rings", "marytitaniumbradoonfixedrings": "mary_titanium_bradoon_fixed_rings",
    "ludwig sweet iron bradoon loose rings": "ludwig_sweet_iron_bradoon_loose_rings", "ludwigsweetironbradoonlooserings": "ludwig_sweet_iron_bradoon_loose_rings",
    "ludwig sweet iron bradoon fixed rings": "ludwig_sweet_iron_bradoon_fixed_rings", "ludwigsweetironbradoonfixedrings": "ludwig_sweet_iron_bradoon_fixed_rings",
    "jesper sweet iron bradoon loose rings": "jesper_sweet_iron_bradoon_loose_rings", "jespersweetironbradoonlooserings": "jesper_sweet_iron_bradoon_loose_rings",
    "jesper sweet iron bradoon fixed rings": "jesper_sweet_iron_bradoon_fixed_rings", "jespersweetironbradoonfixedrings": "jesper_sweet_iron_bradoon_fixed_rings",
    "jenny sweet iron bradoon loose rings": "jenny_sweet_iron_bradoon_loose_rings", "jennysweetironbradoonlooserings": "jenny_sweet_iron_bradoon_loose_rings",
    "jenny sweet iron bradoon fixed rings": "jenny_sweet_iron_bradoon_fixed_rings", "jennysweetironbradoonfixedrings": "jenny_sweet_iron_bradoon_fixed_rings",
    "jasmine titanium bradoon loose rings": "jasmine_titanium_bradoon_loose_rings", "jasminetitaniumbradoonlooserings": "jasmine_titanium_bradoon_loose_rings",
    "jasmine titanium bradoon fixed rings": "jasmine_titanium_bradoon_fixed_rings", "jasminetitaniumbradoonfixedrings": "jasmine_titanium_bradoon_fixed_rings",
    "celice sweet gold bradoon loose rings": "celice_sweet_gold_bradoon_loose_rings", "celicesweetgoldbradoonlooserings": "celice_sweet_gold_bradoon_loose_rings",
    "celice sweet gold bradoon fixed rings": "celice_sweet_gold_bradoon_fixed_rings", "celicesweetgoldbradoonfixedrings": "celice_sweet_gold_bradoon_fixed_rings",
  };

  // === Helpers ===
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

    // Typeform test-payload? (har 'hidden_value' i hidden)
    const isTypeformTest =
      fr?.hidden?.quiz_name === "hidden_value" ||
      fr?.hidden?.ending === "hidden_value" ||
      fr?.hidden?.source === "hidden_value";

    // (valfritt) secret-kontroll
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

    // Email
    const email =
      (fr.answers || []).find((a) => a?.type === "email" && a?.email)?.email ||
      fr.hidden?.email ||
      null;

    if (!email) {
      console.warn("⚠️ No email in submission; skipping Klaviyo send.");
      return res.status(200).json({ ok: true, note: "No email; skipping." });
    }

    // Ending / hidden
    const endingTitle = fr?.calculated?.outcome?.title || fr?.hidden?.ending || "Unknown";
    const ending_key = toEndingKey(endingTitle);

    if (!Object.values(ENDING_LOOKUP).includes(ending_key) && !ENDING_LOOKUP[endingTitle?.toLowerCase?.()]) {
      const k = `${endingTitle} -> ${ending_key}`;
      if (!SEEN_UNKNOWN.has(k)) {
        SEEN_UNKNOWN.add(k);
        console.warn("💡 Ny/omappad ending upptäckt:", k);
      }
    }

    const quiz_name = fr?.hidden?.quiz_name || "FagerBitQuiz";
    const source = fr?.hidden?.source || "Website";
    const submittedAt = fr?.submitted_at || new Date().toISOString();

    // === Klaviyo event (metric by name; kompatibelt schema) ===
    const eventBody = {
      data: {
        type: "event",
        attributes: {
          metric: { name: KLAVIYO_METRIC_NAME },  // <— unikt namn, skapas vid första POST
          profile: { email },                      // profilidentifiering
          properties: {
            quiz_name,
            ending_key,
            ending_title: endingTitle,
            source,
            submitted_at: submittedAt,
            typeform_form_id: fr?.form_id,
            typeform_response_id: fr?.token,
          },
          time: submittedAt,                       // fältnamnet är 'time' i detta schema
        },
      },
    };

    const resp = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        revision: "2024-06-15", // kompatibel revision för metric-by-name-schemat
      },
      body: JSON.stringify(eventBody),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      // Logga men svara 200 till Typeform så den inte rödmarkerar
      console.error("❌ Klaviyo error:", resp.status, txt?.slice(0, 1200));
      return res.status(200).json({
        ok: false,
        upstream: "klaviyo",
        status: resp.status,
        note: "Logged Klaviyo error but returned 200 to Typeform",
      });
    }

    const data = await resp.json().catch(() => ({}));
    console.log("✅ Klaviyo OK", {
      email,
      ending_key,
      metric_name: KLAVIYO_METRIC_NAME,
      id: data?.data?.id,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("💥 Handler error:", err);
    return res.status(200).json({ ok: false, error: "Internal error (logged)" });
  }
}
