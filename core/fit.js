// Tier 4: fit memory.
//
// The last unbuilt tier from the original spec, and the only part of the tool
// that gets better the longer it is used. Sizes on Poshmark are the seller's
// reading of a tag; whether a garment ACTUALLY fits is something only the
// shopper learns, after it arrives. Levi's runs small, Vuori runs long, and no
// alias table will ever know that.
//
// So this records outcomes and turns them into a per-brand adjustment.
//
// Two rules keep it honest, and both are asymmetries the rest of the library
// already lives by:
//
//   1. A learned size only ever WIDENS what is surfaced. It adds a size to the
//      set and says why. It never hides a listing, because "the M fit last
//      time" is evidence about one garment, not proof about this one.
//   2. One outcome is an anecdote. It takes CONSISTENT evidence before the
//      adjustment is applied at all - a single return would otherwise rewrite
//      a size profile that the shopper knows better than we do.

/** Minimum agreeing outcomes before a learned size is trusted enough to use. */
export const MIN_EVIDENCE = 2;

/** One recorded outcome. Everything is lower-cased for comparison but kept as typed for display. */
export function fitEntry({ person, brand, category, size, fits, at = Date.now() }) {
  if (!person || !brand || !category || !size) return null;
  return {
    person: String(person),
    brand: String(brand),
    category: String(category),
    size: String(size).toUpperCase(),
    fits: !!fits,
    at,
  };
}

const key = (e) => [e.person, e.brand.toLowerCase(), e.category].join("|");

/**
 * Add an outcome. The ledger is a flat array so the shopper can see and delete
 * individual entries: a size profile that changed itself for reasons nobody can
 * inspect is worse than no learning at all.
 */
export function recordFit(ledger, entry) {
  const e = fitEntry(entry);
  if (!e) return Array.isArray(ledger) ? ledger : [];
  return [...(Array.isArray(ledger) ? ledger : []), e];
}

/**
 * What this person has learned about this brand and category.
 *
 * Returns { size, fitted, failed, sizes } or null. `size` is the size that has
 * fitted most often and never failed - a size with outcomes on both sides is
 * not a lesson, it is noise, and is left out.
 */
export function learnedSize(ledger, person, brand, category) {
  if (!Array.isArray(ledger) || !person || !brand || !category) return null;
  const want = key({ person, brand, category });
  const bySize = new Map();
  for (const e of ledger) {
    if (key(e) !== want) continue;
    const s = bySize.get(e.size) || { size: e.size, fitted: 0, failed: 0 };
    if (e.fits) s.fitted++; else s.failed++;
    bySize.set(e.size, s);
  }
  if (!bySize.size) return null;

  const clean = [...bySize.values()].filter((s) => s.fitted >= MIN_EVIDENCE && s.failed === 0);
  if (!clean.length) return null;
  // Most-fitted wins; a tie goes to the smaller set of outcomes being irrelevant,
  // so fall back to the size that sorts first for a stable, explainable answer.
  clean.sort((a, b) => b.fitted - a.fitted || String(a.size).localeCompare(String(b.size)));
  return { ...clean[0], sizes: [...bySize.values()] };
}

/**
 * The sizes to look for, given what has been learned.
 *
 * The shopper's own profile always stays in the set. Learning ADDS; it does not
 * replace a stated preference with a guess, however well evidenced.
 */
export function sizesWithFit(baseSizes, ledger, person, brand, category) {
  const base = [...(baseSizes || [])];
  const learned = learnedSize(ledger, person, brand, category);
  if (!learned) return { sizes: base, added: null };
  if (base.some((s) => String(s).toUpperCase() === learned.size)) return { sizes: base, added: null };
  return { sizes: [...base, learned.size], added: learned };
}

/** Plain-language account of why a size was added, for the card and the settings page. */
export function explainFit(learned, brand) {
  if (!learned) return "";
  return `${learned.size} in ${brand} fitted ${learned.fitted} ${learned.fitted === 1 ? "time" : "times"}`;
}

/** Drop one entry by index, for the settings list. */
export function forgetFit(ledger, index) {
  const l = Array.isArray(ledger) ? ledger : [];
  return l.filter((_, i) => i !== index);
}
