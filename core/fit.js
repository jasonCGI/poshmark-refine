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

import { normalizeBrand } from "./normalize.js";

/** Minimum agreeing outcomes before a learned size is trusted enough to use. */
export const MIN_EVIDENCE = 2;

/**
 * The brand as the rest of the library would name it.
 *
 * The outcome is typed into a free-text box, so "Levis" arrives where a card
 * parses to "Levi's". Keying evidence on the raw text produced a lesson the
 * settings page displayed and the verdict could never match, because verdicts
 * look up the CANONICAL brand. Both sides now agree.
 *
 * A brand we do not recognise keeps what was typed, so an unknown label is
 * still learnable - it just matches only itself.
 */
export function canonicalBrand(raw, aliases) {
  const typed = String(raw || "").trim();
  if (!typed) return "";
  const known = aliases ? normalizeBrand(typed, aliases) : normalizeBrand(typed);
  return known.canonical || typed;
}

/**
 * One recorded outcome.
 *
 * `id` exists because the settings list used to delete BY ARRAY INDEX against a
 * freshly read ledger. If anything removed an entry in between - another
 * settings tab, another window - the click deleted whatever had shifted into
 * that slot. Identity is stable; position is not.
 */
export function fitEntry({ person, brand, category, size, fits, at = Date.now(), id, aliases }) {
  if (!person || !brand || !category || !size) return null;
  const canon = canonicalBrand(brand, aliases);
  if (!canon) return null;
  return {
    id: id || `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    person: String(person),
    brand: canon,
    category: String(category),
    size: String(size).toUpperCase(),
    fits: !!fits,
    at,
  };
}

const key = (e) => [e.person, String(e.brand).toLowerCase(), e.category].join("|");

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
  if (!learned) return { sizes: base, added: null, learned: null };
  const already = base.some((s) => String(s).toUpperCase() === learned.size);
  // `added` says whether the SET grew. `learned` says what this person knows,
  // and is returned either way: a size another household member already
  // contributed is still this person's lesson, and dropping it here is how a
  // match came to name the wrong person and lose its explanation.
  return { sizes: already ? base : [...base, learned.size], added: already ? null : learned, learned };
}

/** Plain-language account of why a size was added, for the card and the settings page. */
export function explainFit(learned, brand) {
  if (!learned) return "";
  return `${learned.size} in ${brand} fitted ${learned.fitted} ${learned.fitted === 1 ? "time" : "times"}`;
}

/**
 * Drop one outcome BY IDENTITY, for the settings list.
 *
 * Never by index: the list the shopper clicked may be a render older than the
 * ledger they are deleting from.
 */
export function forgetFit(ledger, id) {
  const l = Array.isArray(ledger) ? ledger : [];
  if (!id) return l;
  return l.filter((e) => e.id !== id);
}

/**
 * Bring an older ledger up to date: give entries an id, and canonicalise brands
 * recorded before both existed. Idempotent.
 */
export function migrateLedger(ledger, aliases) {
  if (!Array.isArray(ledger)) return [];
  return ledger.map((e) => fitEntry({ ...e, aliases })).filter(Boolean);
}
