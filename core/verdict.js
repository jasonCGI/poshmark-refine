// One verdict per card: show, hide, or dim - and always a reason.
//
// The verdict is where the product's rule lives:
//   * a KNOWN attribute that contradicts the shopper's intent HIDES the card,
//     with the reason spelled out ("size L, you asked for S");
//   * an UNKNOWN attribute never hides - the card is DIMMED and sorted down,
//     because a seller's omission is not evidence against the item;
//   * everything known and matching SHOWS; an inferred size match shows with a
//     note, because brands disagree about numeric-to-letter conversion.
//
// Pure. The content script feeds it parsed cards and a resolved intent; the
// tests feed it captured card text.

import { normalizeSize, sizeMatches, normalizeBrand, coloursFromTitle } from "./normalize.js";

/**
 * Parse the text fields of one result card into attributes with confidence.
 * `fields` mirrors the card selectors in the fixture: { title, size, condition }.
 */
export function parseCard(fields) {
  const title = String(fields.title || "").trim();
  return {
    title,
    size: normalizeSize(fields.size),
    brand: normalizeBrand(title),
    colours: coloursFromTitle(title),
    condition: String(fields.condition || "").trim(),
  };
}

/**
 * Build a shopper intent from a family profile.
 *
 * `profiles` is { personName: { tops: ["S", "M"], jeans: [...], ... } }.
 * `who` is a person's name or "anyone" (union of everyone's sizes).
 * `brands` / `colours` are optional arrays of canonical names; null = no
 * constraint on that attribute.
 */
export function intentFor(profiles, who, category, { brands = null, colours = null } = {}) {
  const people = who === "anyone" ? Object.keys(profiles) : [who];
  const sizes = new Set();
  for (const p of people) {
    for (const s of (profiles[p] && profiles[p][category]) || []) sizes.add(s);
  }
  return {
    sizes: sizes.size ? sizes : null,
    brands: brands && brands.length ? new Set(brands) : null,
    colours: colours && colours.length ? new Set(colours) : null,
    who,
    category,
  };
}

/**
 * Decide. Returns { state: 'show'|'hide'|'dim', reasons: string[], notes: string[] }.
 * `reasons` explains a hide or a dim; `notes` explains an inferred match.
 */
export function verdict(card, intent) {
  const reasons = [];
  const notes = [];
  let unknown = false;

  if (intent.sizes) {
    const results = [...intent.sizes].map((w) => sizeMatches(card.size, w));
    if (results.includes("exact")) {
      // fits
    } else if (results.includes("inferred")) {
      notes.push(`size ${card.size.raw} likely fits ${[...intent.sizes].join("/")} (numeric-to-letter is brand-dependent)`);
    } else if (results.every((r) => r === "unknown")) {
      unknown = true;
      reasons.push(card.size.raw ? `size "${card.size.raw}" not readable` : "no size on the card");
    } else {
      reasons.push(`size ${card.size.canonical}, you asked for ${[...intent.sizes].join("/")}`);
      return { state: "hide", reasons, notes };
    }
  }

  if (intent.brands) {
    if (card.brand.confidence === "unknown") {
      unknown = true;
      reasons.push("no known brand in the title");
    } else if (!intent.brands.has(card.brand.canonical)) {
      reasons.push(`brand ${card.brand.canonical}, you asked for ${[...intent.brands].join("/")}`);
      return { state: "hide", reasons, notes };
    }
  }

  if (intent.colours) {
    if (card.colours.size === 0) {
      unknown = true;
      reasons.push("no colour in the title (listing page may say)");
    } else if (![...card.colours].some((c) => intent.colours.has(c))) {
      reasons.push(`colour ${[...card.colours].join("/")}, you asked for ${[...intent.colours].join("/")}`);
      return { state: "hide", reasons, notes };
    }
  }

  return { state: unknown ? "dim" : "show", reasons, notes };
}

/** Sort order for the grid: shows first, then dims; hides are not rendered. */
export const STATE_ORDER = { show: 0, dim: 1, hide: 2 };
