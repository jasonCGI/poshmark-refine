// Saved searches.
//
// A preset captures WHAT YOU ARE LOOKING FOR - the query, the brands, the
// colours, the price ceiling - so "work tops for me" or "Vuori purple M" is one
// click instead of six fields.
//
// What a preset deliberately does NOT capture is `profiles`: the family's sizes
// are a standing fact about people, not part of a search. A preset that carried
// them would silently rewrite everyone's sizes every time it was applied, which
// is exactly the clobbering the storage merge discipline exists to prevent. It
// stores `who` (whose sizes to use) and leaves the sizes themselves alone.

/** The fields a preset owns. Anything not listed here is never touched. */
export const PRESET_FIELDS = [
  "query", "department", "category", "who",
  "brands", "colours", "colourTerms", "maxPrice", "conditions",
];

const clone = (v) => (Array.isArray(v) ? v.slice() : v);

/** Snapshot the current criteria under a name. */
export function capturePreset(name, settings = {}) {
  const p = { name: String(name || "").trim() };
  for (const f of PRESET_FIELDS) if (settings[f] !== undefined) p[f] = clone(settings[f]);
  return p;
}

/**
 * Settings with this preset applied. Only PRESET_FIELDS change; profiles, the
 * behaviour toggles and anything else the shopper set are carried through
 * untouched. A field absent from the preset is CLEARED, so applying a preset
 * gives the same search every time rather than inheriting leftovers from the
 * last one.
 */
export function applyPreset(settings = {}, preset = {}) {
  const next = Object.assign({}, settings);
  for (const f of PRESET_FIELDS) {
    if (preset[f] !== undefined) next[f] = clone(preset[f]);
    else if (Array.isArray(settings[f])) next[f] = [];
    else if (f === "maxPrice") next[f] = null;
  }
  // A preset replaces every field a brand page had set, so the note saying the
  // brand came from that page stops being true. It is provenance, not a
  // setting, which is also why it is not in PRESET_FIELDS.
  delete next.fromBridge;
  return next;
}

/** Add or replace by name (case-insensitive). Returns a new list. */
export function upsertPreset(list = [], preset) {
  if (!preset || !preset.name) return list.slice();
  const out = list.filter((p) => p.name.toLowerCase() !== preset.name.toLowerCase());
  out.push(preset);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove by name (case-insensitive). Returns a new list. */
export function removePreset(list = [], name) {
  const n = String(name || "").toLowerCase();
  return list.filter((p) => p.name.toLowerCase() !== n);
}

/** A short human summary for a preset chip's tooltip. */
export function describePreset(p = {}) {
  const bits = [];
  if (p.query) bits.push('"' + p.query + '"');
  if (p.brands && p.brands.length) bits.push(p.brands.join("/"));
  if (p.colourTerms && p.colourTerms.length) bits.push(p.colourTerms.join("/"));
  else if (p.colours && p.colours.length) bits.push(p.colours.join("/"));
  if (p.category) bits.push(p.category);
  if (p.who) bits.push("for " + p.who);
  if (p.maxPrice) bits.push("under $" + p.maxPrice);
  if (p.conditions && p.conditions.length) bits.push(p.conditions.join("/").toUpperCase());
  return bits.join(" · ") || "no criteria";
}
