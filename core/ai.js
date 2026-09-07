// Optional on-device attribute reader, using Chrome's built-in Prompt API.
//
// Why this is allowed to exist at all: Gemini Nano runs ON THE DEVICE. No text
// leaves the machine, so the extension's promise - "reads the page you loaded,
// sends nothing about you anywhere" - is intact. That is the whole reason this
// is the Prompt API and not a cloud model.
//
// Where it sits: BEHIND the deterministic passes, never in front. The tables and
// regexes decide first; the model is asked only about what is still unknown -
// the dimmed cards. It can therefore only ever ADD information.
//
// And it inherits the asymmetry the described-size rule established: a model
// reading is good enough to SURFACE a likely match, never good enough to
// DISCARD an item. A contradiction from the model dims and says so.
//
// The API is injected rather than reached for globally, so all of this is
// testable without a browser.

export const AI_UNAVAILABLE = "unavailable";

/** Structured output contract. Every field may be null - unknown stays first class. */
export const ATTRIBUTE_SCHEMA = {
  type: "object",
  properties: {
    size: { type: ["string", "null"], description: "Size as written, e.g. M, XL, 8, 8.5. null if not stated." },
    colour: { type: ["string", "null"], description: "The main colour word or colourway name. null if not stated." },
    brand: { type: ["string", "null"], description: "Brand name. null if not stated." },
  },
  required: ["size", "colour", "brand"],
  additionalProperties: false,
};

/** Chrome has moved this global around; accept either spelling, else null. */
export function resolveApi(scope = globalThis) {
  if (!scope) return null;
  if (scope.LanguageModel) return scope.LanguageModel;
  if (scope.ai && scope.ai.languageModel) return scope.ai.languageModel;
  return null;
}

/**
 * Can we use it? Returns one of the API's own states, or "unavailable" when the
 * API is missing entirely. Never throws - this is a bonus tier and must not be
 * able to break the page.
 */
export async function availability(api) {
  try {
    if (!api) return AI_UNAVAILABLE;
    if (typeof api.availability === "function") return await api.availability();
    // older surface
    if (typeof api.capabilities === "function") {
      const c = await api.capabilities();
      return (c && c.available) || AI_UNAVAILABLE;
    }
    return AI_UNAVAILABLE;
  } catch (e) {
    return AI_UNAVAILABLE;
  }
}

/** Usable right now (not merely downloadable). */
export const isReady = (state) => state === "available" || state === "readily";

/**
 * The question. Deliberately narrow: read what is written, do not infer, and say
 * null rather than guess - the same contract the rest of the engine keeps.
 */
export function buildPrompt({ title = "", body = "" } = {}) {
  return [
    "Read this second-hand clothing listing and report ONLY what it actually states.",
    "Do not infer, do not guess, do not use world knowledge about the brand.",
    "If the listing does not state a value, return null for it.",
    "",
    "TITLE: " + String(title).slice(0, 300),
    body ? "DETAILS: " + String(body).slice(0, 1200) : "",
  ].filter(Boolean).join("\n");
}

/** Tolerant parse. Anything unparseable is all-unknown, never a partial guess. */
export function parseAiAnswer(raw) {
  const empty = { size: null, colour: null, brand: null };
  if (!raw) return empty;
  let obj = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return empty;
    try { obj = JSON.parse(m[0]); } catch (e) { return empty; }
  }
  if (!obj || typeof obj !== "object") return empty;
  const clean = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s || /^(null|none|n\/a|unknown|not stated)$/i.test(s)) return null;
    return s;
  };
  return { size: clean(obj.size), colour: clean(obj.colour), brand: clean(obj.brand) };
}

/**
 * Ask the model about one listing. Returns the parsed attributes, or all-null on
 * any failure. Callers must treat every value as WEAK evidence.
 */
export async function readAttributes(api, card, { session = null } = {}) {
  try {
    if (!api) return parseAiAnswer(null);
    const s = session || await api.create({
      initialPrompts: [{
        role: "system",
        content: "You extract stated attributes from second-hand clothing listings. You never guess.",
      }],
    });
    const out = await s.prompt(buildPrompt(card), { responseConstraint: ATTRIBUTE_SCHEMA });
    if (!session && s.destroy) s.destroy();
    return parseAiAnswer(out);
  } catch (e) {
    return parseAiAnswer(null);
  }
}

/**
 * Fold a model reading into a card.
 *
 * Rules, in order of importance:
 *  1. It NEVER overwrites something the deterministic pass already knows.
 *  2. What it contributes is marked weak, so the verdict can refuse to hide on it.
 *  3. Nothing it says is treated as exact.
 *
 * Returns a NEW card; the original is untouched.
 */
export function mergeAiIntoCard(card, ai, { normalizeSize, coloursFromTitle } = {}) {
  const out = Object.assign({}, card);
  const said = ai || { size: null, colour: null, brand: null };

  if (said.size && card.size && card.size.confidence === "unknown" && normalizeSize) {
    const parsed = normalizeSize(said.size, card.category);
    // reuse the described-size channel: surfaces a match, never hides
    if (parsed.confidence === "exact") out.describedSize = Object.assign({}, parsed, { confidence: "described", raw: said.size });
  }
  if (said.colour && coloursFromTitle && !(card.colours && card.colours.size)) {
    const fams = coloursFromTitle(said.colour);
    if (fams.size) out.bodyColours = new Set([...(card.bodyColours || []), ...fams]);
  }
  if (said.brand && card.brand && card.brand.confidence === "unknown") {
    out.brand = { canonical: said.brand, confidence: "ai" };
  }
  out.aiRead = said;
  return out;
}
