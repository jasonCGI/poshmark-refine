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
  brandIndexWith, colourIndexWith,
} from "./normalize.js";

/**
 * Parse the text fields of one result card into attributes with confidence.
 * `fields` mirrors the card selectors in the fixture: { title, size, condition }.
 */
import { sizesWithFit, explainFit } from "./fit.js";

export function parseCard(fields, category = "tops", corrections = null) {
  const title = String(fields.title || "").trim();
  // The shopper's corrections extend the shipped tables; they never replace the
  // reasoning. A corrected brand is still "found in the title", not a guess.
  const brandIdx = brandIndexWith(corrections && corrections.brands);
  const colourIdx = colourIndexWith(corrections && corrections.colours);
  return {
    title,
    category,
    size: normalizeSize(fields.size, category),
    brand: normalizeBrand(title, brandIdx),
    colours: coloursFromTitle(title, colourIdx),
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
export function intentFor(profiles, who, category, { brands = null, colours = null, colourTerms = null, maxPrice = null, conditions = null, fitLedger = null } = {}) {
  const people = who === "anyone" ? Object.keys(profiles) : [who];
  const sizes = new Set();
  // Who each size belongs to. The union used to throw this away, so shopping
  // for the family produced a card marked "Match" that never said WHICH person
  // it fits - leaving the shopper to work it out by eye, which is the manual
  // filtering this whole tool exists to remove.
  const owners = {};
  for (const p of people) {
    for (const s of (profiles[p] && profiles[p][category]) || []) {
      sizes.add(s);
      (owners[s] = owners[s] || []).push(p);
    }
  }
  return {
    sizes: sizes.size ? sizes : null,
    owners,
    brands: brands && brands.length ? new Set(brands) : null,
    colours: colours && colours.length ? new Set(colours) : null,
    colourTerms: colourTerms && colourTerms.length ? colourTerms.filter(Boolean) : null,
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
    conditions: conditions && conditions.length ? new Set(conditions) : null,
    who,
    category,
    // Tier 4. Held on the intent but applied per-card in verdict(), because the
    // adjustment depends on the card's brand, which is not known until we see it.
    fitLedger: Array.isArray(fitLedger) && fitLedger.length ? fitLedger : null,
  };
}

/**
 * Decide. Returns { state: 'show'|'hide'|'dim', reasons: string[], notes: string[] }.
 * `reasons` explains a hide or a dim; `notes` explains an inferred match.
 */
export function verdict(card, intent) {
  const reasons = [];
  const notes = [];
  const fits = [];
  let unknown = false;

  if (intent.sizes) {
    let wanted = [...intent.sizes];
    // Per-card view of who wears what. Starts from the intent and may gain a
    // learned size below; the intent itself is never touched.
    const owners = Object.assign({}, intent.owners);
    // Tier 4: what this shopper has learned about THIS brand. It only ever adds
    // a size, and only on consistent evidence - see core/fit.js.
    const fitBySize = new Map();
    if (intent.fitLedger && card.brand && card.brand.canonical) {
      // Shopping for the family, each person's own history applies: what fits
      // one of them says nothing about the others, so they are widened
      // separately rather than pooled.
      const people = intent.who === "anyone"
        ? [...new Set(Object.values(intent.owners || {}).flat())]
        : [intent.who];
      for (const person of people) {
        const widened = sizesWithFit(wanted, intent.fitLedger, person, card.brand.canonical, intent.category);
        // Note the lesson even when the size was ALREADY in the set - another
        // person may have contributed it, and it is still this person's
        // evidence. Skipping here made a match name the wrong household member.
        if (!widened.learned) continue;
        wanted = widened.sizes;
        // Keyed by size, not a single slot: one `fitAdded` was overwritten by
        // the next person in the loop, so the first person's explanation was
        // lost from the card.
        fitBySize.set(widened.learned.size, widened.learned);
        // Record the owner LOCALLY. intent is shared across every card on the
        // page, so mutating it would leak one card's lesson onto every card
        // judged afterwards.
        const list = owners[widened.learned.size] = (owners[widened.learned.size] || []).slice();
        if (!list.includes(person)) list.push(person);
      }
    }
    const results = wanted.map((w) => sizeMatches(card.size, w, intent.category || card.category));
    // Which people the sizes that actually matched belong to. Order follows the
    // profile order, not the size order, so a household reads the same way every
    // time.
    const matchedSizes = wanted.filter((w, i) => results[i] === "exact" || results[i] === "inferred");
    for (const w of matchedSizes) {
      for (const person of owners[w] || []) {
        if (!fits.includes(person)) fits.push(person);
      }
    }
    if (results.includes("exact")) {
      // fits. Say so when it was the LEARNED size that matched, not the stated
      // one - a surfaced item the shopper did not ask for owes an explanation.
      const i = wanted.findIndex((w, n) => results[n] === "exact");
      const lesson = i >= 0 ? fitBySize.get(String(wanted[i]).toUpperCase()) : null;
      // Explain only when the shopper did not ask for this size themselves.
      if (lesson && !(intent.sizes && [...intent.sizes].some((s) => String(s).toUpperCase() === lesson.size))) {
        notes.push(`${explainFit(lesson, card.brand.canonical)}, so this size is included`);
      }
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
      // A brand READ BY THE MODEL is weak evidence, like a described size: good
      // enough to surface, never good enough to discard. Only a brand found in
      // the title by the table may hide a card.
      if (card.brand.confidence === "ai") {
        unknown = true;
        reasons.push(`on-device read suggests ${card.brand.canonical} - kept for you to judge`);
      } else {
        reasons.push(`brand ${card.brand.canonical}, you asked for ${[...intent.brands].join("/")}`);
        return { state: "hide", reasons, notes, cause: "brand" };
      }
    }
  }

  if (intent.colours) {
    // Two sources, and they do NOT carry equal weight.
    //
    // The TITLE is the seller's own words about this specific item, so a colour
    // there that contradicts the ask is real evidence: hide it.
    //
    // The listing's structured colour field is a ~16-option dropdown. It is
    // coarse by construction - a "Blue" that is really teal, a "Grey" that is
    // really greige - so a contradiction from that source alone is not enough to
    // discard an item. It DIMS and says so, which keeps the promise that we
    // never throw away a listing on weak evidence.
    const titleHit = card.colours.size
      ? [...card.colours].some((c) => intent.colours.has(c)) : null;
    const bodyColours = card.bodyColours instanceof Set ? card.bodyColours : null;
    const bodyHit = bodyColours && bodyColours.size
      ? [...bodyColours].some((c) => intent.colours.has(c)) : null;

    if (titleHit === true || bodyHit === true) {
      // one good source agreeing is enough
    } else if (titleHit === false) {
      reasons.push(`colour ${[...card.colours].join("/")}, you asked for ${[...intent.colours].join("/")}`);
      return { state: "hide", reasons, notes, cause: "colour" };
    } else if (bodyHit === false) {
      unknown = true;
      reasons.push(`listing says ${[...bodyColours].join("/")}, but that field is coarse - kept for you to judge`);
    } else {
      unknown = true;
      reasons.push("no colour in the title (listing page may say)");
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

  return { state: unknown ? "dim" : "show", reasons, notes, fits };
}

/** Sort order for the grid: shows first, then dims; hides are not rendered. */
export const STATE_ORDER = { show: 0, dim: 1, hide: 2 };
