// Normalisers for the three attributes Poshmark search ignores: size, brand,
// colour. Pure functions, no DOM, no browser API - so they are tested against
// captured card text and nothing else.
//
// The rule that governs every function here: a seller's text NARROWS what an
// item might be; it does not identify it. So each normaliser returns a
// confidence alongside its answer, and "unknown" is a first-class result -
// never coerced into a guess. A typo like `X8` is unknown, not `XS`.

// ---------------------------------------------------------------- size --------

// Canonical letter sizes for tops, in order. Plus sizes are their own scale.
export const LETTER_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];
export const PLUS_SIZES = ["1X", "2X", "3X", "4X", "5X"];

// Spellings sellers actually use, lowercased, mapped to a canonical letter.
const LETTER_ALIASES = new Map([
  ["xxs", "XXS"], ["2xs", "XXS"], ["xx-small", "XXS"], ["xxsmall", "XXS"],
  ["xs", "XS"], ["x-small", "XS"], ["xsmall", "XS"], ["extra small", "XS"], ["extra-small", "XS"],
  ["s", "S"], ["sm", "S"], ["small", "S"],
  ["m", "M"], ["med", "M"], ["medium", "M"],
  ["l", "L"], ["lg", "L"], ["large", "L"],
  ["xl", "XL"], ["x-large", "XL"], ["xlarge", "XL"], ["extra large", "XL"], ["extra-large", "XL"],
  ["xxl", "XXL"], ["2xl", "XXL"], ["xx-large", "XXL"], ["xxlarge", "XXL"],
  ["xxxl", "XXXL"], ["3xl", "XXXL"],
]);

// US numeric women's tops -> the letter range they are USUALLY sold as. This
// is an INFERENCE, brand-dependent, so a match through it is reported as
// `inferred`, never `exact`.
const US_NUMERIC_TO_LETTER = new Map([
  [0, "XXS"], [2, "XS"], [4, "S"], [6, "S"], [8, "M"], [10, "M"],
  [12, "L"], [14, "L"], [16, "XL"], [18, "XXL"], [20, "XXL"],
]);

/**
 * Read the card's size field.
 *
 * Returns { canonical, kind, confidence, raw } where kind is 'letter' | 'plus' |
 * 'us' and confidence is 'exact' | 'unknown'. Nothing here infers; inference
 * happens in `sizeMatches`, where the shopper's intent is known.
 */
export function normalizeSize(raw) {
  const text = String(raw || "").trim();
  if (!text) return { canonical: null, kind: null, confidence: "unknown", raw: text };
  let t = text.toLowerCase().replace(/^size[:\s]+/, "").trim();

  // `M/M`, `S / S` - the same size typed twice by a seller filling two boxes.
  const doubled = t.match(/^([a-z0-9\-]+)\s*\/\s*([a-z0-9\-]+)$/);
  if (doubled && doubled[1] === doubled[2]) t = doubled[1];

  if (LETTER_ALIASES.has(t)) return { canonical: LETTER_ALIASES.get(t), kind: "letter", confidence: "exact", raw: text };

  const plus = t.match(/^([1-5])\s*x$/);
  if (plus) return { canonical: plus[1] + "X", kind: "plus", confidence: "exact", raw: text };

  const us = t.match(/^(?:us\s*)?(\d{1,2})$/);
  if (us) return { canonical: "US " + parseInt(us[1], 10), kind: "us", confidence: "exact", raw: text };

  // `X8`, `Sz`, `OS`, free text - not readable. Unknown, deliberately.
  return { canonical: null, kind: null, confidence: "unknown", raw: text };
}

/**
 * Does a card size satisfy a shopper's canonical size?
 *
 * Returns 'exact' | 'inferred' | 'no' | 'unknown'. `inferred` covers a US
 * numeric card matched to a letter intent (or vice versa) through the
 * conversion table - shown, but flagged, because brands disagree about it.
 */
export function sizeMatches(cardSize, wanted) {
  if (!cardSize || cardSize.confidence === "unknown") return "unknown";
  const want = normalizeSize(wanted);
  if (want.confidence === "unknown") return "unknown";
  if (cardSize.canonical === want.canonical) return "exact";
  if (cardSize.kind === want.kind) return "no";
  // cross-scale: US numeric <-> letter
  const usSide = cardSize.kind === "us" ? cardSize : want.kind === "us" ? want : null;
  const letterSide = cardSize.kind === "letter" ? cardSize : want.kind === "letter" ? want : null;
  if (usSide && letterSide) {
    const n = parseInt(usSide.canonical.replace("US ", ""), 10);
    return US_NUMERIC_TO_LETTER.get(n) === letterSide.canonical ? "inferred" : "no";
  }
  return "no";
}

// --------------------------------------------------------------- brand --------

/**
 * Brand alias table: canonical -> spellings sellers use. Only the entries
 * needed by the captured fixtures plus the obvious ones; it grows from the
 * shopper's corrections, never from guessing.
 */
export const BRAND_ALIASES = {
  "Rails": ["rails"],
  "Madewell": ["madewell"],
  "Prana": ["prana"],
  "Joie": ["joie"],
  "Doen": ["doen", "dôen"],
  "Vince Camuto": ["vince camuto"],
  "Anthropologie": ["anthropologie", "anthro", "maeve"],
  "Faherty": ["faherty"],
  "Aritzia": ["aritzia", "babaton", "wilfred"],
  "Levi's": ["levi's", "levis", "levi strauss", "levi’s"],
  "Abercrombie & Fitch": ["abercrombie & fitch", "abercrombie", "a&f"],
  "ASTR the Label": ["astr the label", "astr"],
  "L'AGENCE": ["l'agence", "lagence", "l’agence"],
  "Free People": ["free people", "fp"],
  "Zara": ["zara"],
  "J.Crew": ["j.crew", "j crew", "jcrew"],
  "Lululemon": ["lululemon", "lulu"],
};

const BRAND_INDEX = Object.entries(BRAND_ALIASES)
  .flatMap(([canon, aliases]) => aliases.map((a) => [a.toLowerCase(), canon]))
  .sort((a, b) => b[0].length - a[0].length); // longest alias first

/**
 * Brand from a card. The 2026 card has no brand element, so the title is the
 * only source. Match whole words, longest alias first. Returns
 * { canonical, confidence } with confidence 'title' (found in title) or
 * 'unknown' (no known brand word present - NOT "no brand").
 */
export function normalizeBrand(title, aliases = BRAND_INDEX) {
  const t = " " + String(title || "").toLowerCase().replace(/[^\p{L}\p{N}'’&.]+/gu, " ") + " ";
  for (const [alias, canon] of aliases) {
    if (t.includes(" " + alias + " ")) return { canonical: canon, confidence: "title" };
  }
  return { canonical: null, confidence: "unknown" };
}

// -------------------------------------------------------------- colour --------

/**
 * Colour families. A shopper asks for "pink"; sellers write blush, rosewood,
 * coral, dusty mauve. Each family lists the words that map INTO it. A word
 * can belong to two families where sellers genuinely use it both ways
 * (cream -> white and beige).
 */
export const COLOUR_FAMILIES = {
  black: ["black", "noir", "onyx", "jet"],
  white: ["white", "ivory", "cream", "off-white", "off white", "eggshell", "bone"],
  grey: ["grey", "gray", "charcoal", "heather", "slate", "silver"],
  beige: ["beige", "tan", "khaki", "camel", "sand", "cream", "oat", "oatmeal", "nude", "taupe", "butter"],
  brown: ["brown", "chocolate", "coffee", "mocha", "cognac", "rust", "chestnut", "espresso"],
  red: ["red", "burgundy", "wine", "maroon", "crimson", "scarlet", "cherry", "brick"],
  pink: ["pink", "blush", "rose", "rosewood", "coral", "fuchsia", "magenta", "mauve", "dusty mauve", "salmon", "peach"],
  orange: ["orange", "coral", "peach", "apricot", "tangerine", "rust", "terracotta", "sunset"],
  yellow: ["yellow", "mustard", "gold", "lemon", "butter", "marigold"],
  green: ["green", "olive", "sage", "emerald", "forest", "mint", "lime", "khaki", "rye green", "moss", "hunter"],
  blue: ["blue", "navy", "cobalt", "royal", "sky", "denim", "chambray", "indigo", "teal", "aqua", "turquoise", "light blue"],
  purple: ["purple", "lavender", "lilac", "plum", "violet", "eggplant", "mauve", "dusty mauve"],
  multi: ["multi", "multicolor", "multicolour", "floral", "print", "printed", "pattern", "patterned", "polka dot", "striped", "stripe", "plaid", "tie dye", "tye dye", "leopard", "cheetah"],
};

const COLOUR_INDEX = Object.entries(COLOUR_FAMILIES)
  .flatMap(([family, words]) => words.map((w) => [w, family]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Colour families present in a title. Returns a Set (possibly empty). Empty
 * means UNKNOWN - the title said nothing about colour - not "no colour".
 * Multi-word phrases match before their single words (`dusty mauve` before
 * `mauve`) so a phrase counts once.
 */
export function coloursFromTitle(title) {
  let t = " " + String(title || "").toLowerCase().replace(/[^\p{L}\p{N}\-]+/gu, " ") + " ";
  const found = new Set();
  for (const [word, family] of COLOUR_INDEX) {
    const needle = " " + word + " ";
    if (t.includes(needle)) {
      found.add(family);
      t = t.split(needle).join(" ");
    }
  }
  return found;
}
