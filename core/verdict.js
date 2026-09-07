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

import {
  normalizeSize, sizeMatches, normalizeBrand, coloursFromTitle,
  parsePrice, normalizeCondition, matchesColourTerm,
} from "./normalize.js";

/**
 * Parse the text fields of one result card into attributes with confidence.
 * `fields` mirrors the card selectors in the fixture: { title, size, condition }.
 */
export function parseCard(fields, category = "tops") {
  const title = String(fields.title || "").trim();
  return {
    title,
    category,
    size: normalizeSize(fields.size, category),
    brand: normalizeBrand(title),
    colours: coloursFromTitle(title),
    price: parsePrice(fields.price),
    condition: String(fields.condition || "").trim(),
    // Poshmark badges NWT and shows nothing for used, so an EMPTY badge is real
    // information. A MISSING element is not: the caller passes false then.
    conditionKnown: fields.conditionKnown !== false,
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
export function intentFor(profiles, who, category, { brands = null, colours = null, colourTerms = null, maxPrice = null, conditions = null } = {}) {
  const people = who === "anyone" ? Object.keys(profiles) : [who];
  const sizes = new Set();
  for (const p of people) {
    for (const s of (profiles[p] && profiles[p][category]) || []) sizes.add(s);
  }
  return {
    sizes: sizes.size ? sizes : null,
    brands: brands && brands.length ? new Set(brands) : null,
    colours: colours && colours.length ? new Set(colours) : null,
    colourTerms: colourTerms && colourTerms.length ? colourTerms.filter(Boolean) : null,
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
    conditions: conditions && conditions.length ? new Set(conditions) : null,
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
    const results = [...intent.sizes].map((w) => sizeMatches(card.size, w, intent.category || card.category));
    if (results.includes("exact")) {
      // fits
    } else if (results.includes("inferred")) {
      notes.push(`size ${card.size.raw} likely fits ${[...intent.sizes].join("/")} (numeric-to-letter is brand-dependent)`);
    } else if (results.every((r) => r === "unknown")) {
      // The card has no readable size. If Tier-3 read one out of the listing's
      // DESCRIPTION, use it - but asymmetrically. A described size is the
      // seller's estimate ("tag is missing, similar garments are Size XL"), so
      // it is strong enough to SURFACE a likely match and never strong enough
      // to DISCARD an item. A contradiction leaves the card dimmed and says so.
      const d = card.describedSize
        ? [...intent.sizes].map((w) => sizeMatches(card.describedSize, w, intent.category || card.category))
        : null;
      if (d && (d.includes("exact") || d.includes("inferred"))) {
        notes.push(`listing body says size ${card.describedSize.canonical} (the seller's description, not a tag)`);
      } else if (d) {
        unknown = true;
        reasons.push(`listing body suggests ${card.describedSize.canonical}, which does not match - kept for you to judge`);
      } else {
        unknown = true;
        reasons.push(card.size.raw ? `size "${card.size.raw}" not readable` : "no size on the card");
      }
    } else {
      reasons.push(`size ${card.size.canonical}, you asked for ${[...intent.sizes].join("/")}`);
      return { state: "hide", reasons, notes, cause: "size" };
    }
  }

  if (intent.brands) {
    if (card.brand.confidence === "unknown") {
      unknown = true;
      reasons.push("no known brand in the title");
    } else if (!intent.brands.has(card.brand.canonical)) {
      reasons.push(`brand ${card.brand.canonical}, you asked for ${[...intent.brands].join("/")}`);
      return { state: "hide", reasons, notes, cause: "brand" };
    }
  }

  if (intent.colours) {
    if (card.colours.size === 0) {
      unknown = true;
      reasons.push("no colour in the title (listing page may say)");
    } else if (![...card.colours].some((c) => intent.colours.has(c))) {
      reasons.push(`colour ${[...card.colours].join("/")}, you asked for ${[...intent.colours].join("/")}`);
      return { state: "hide", reasons, notes, cause: "colour" };
    }
  }

  // A shopper's own colourway name ("Bay Blue"). Brands name colours far more
  // precisely than a family can, but those names live on the listing rather than
  // the card, so a miss DIMS and lets Tier-3 look. It never hides.
  if (intent.colourTerms) {
    const hit = matchesColourTerm(card.title + " " + (card.bodyText || ""), intent.colourTerms);
    if (hit) {
      notes.push(`colourway "${hit}"`);
    } else {
      unknown = true;
      reasons.push(`colourway ${intent.colourTerms.map((t) => `"${t}"`).join(" or ")} not named here (listing may say)`);
    }
  }

  if (intent.maxPrice) {
    if (card.price == null) {
      unknown = true;
      reasons.push("no price on the card");
    } else if (card.price > intent.maxPrice) {
      reasons.push(`$${card.price}, over your $${intent.maxPrice}`);
      return { state: "hide", reasons, notes, cause: "price" };
    }
  }

  if (intent.conditions) {
    if (!card.conditionKnown) {
      unknown = true;
      reasons.push("condition not shown");
    } else {
      const c = normalizeCondition(card.condition);
      if (!intent.conditions.has(c)) {
        reasons.push(`${c === "used" ? "not new" : c.toUpperCase()}, you asked for ${[...intent.conditions].join("/").toUpperCase()}`);
        return { state: "hide", reasons, notes, cause: "condition" };
      }
    }
  }

  return { state: unknown ? "dim" : "show", reasons, notes };
}

/** Sort order for the grid: shows first, then dims; hides are not rendered. */
export const STATE_ORDER = { show: 0, dim: 1, hide: 2 };
