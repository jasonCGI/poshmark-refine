// Core tests. Every assertion is against captured card text from a real
// search (fixtures/) or a spelling seen in one. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSize, sizeMatches, normalizeBrand, coloursFromTitle } from "../core/normalize.js";
import { parseCard, intentFor, verdict } from "../core/verdict.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/tops-blouse-2026-09-05.json", import.meta.url), "utf8"));
const cards = fx.rows.map(([title, size, condition]) => parseCard({ title, size, condition }));

// ------------------------------------------------------------- size ----------
test("every fixture size parses without throwing, and exactly one is unknown", () => {
  const unknown = cards.filter((c) => c.size.confidence === "unknown");
  assert.equal(unknown.length, 1, unknown.map((c) => c.size.raw).join(","));
  assert.equal(unknown[0].size.raw, "X8", "the seller's typo for XS is unknown, not guessed");
});

test("a doubled size collapses to one", () => {
  assert.equal(normalizeSize("M/M").canonical, "M");
  assert.equal(normalizeSize("S / S").canonical, "S");
});

test("letter spellings normalise to one canonical", () => {
  for (const [raw, want] of [["Medium", "M"], ["med", "M"], ["Small", "S"], ["Large", "L"], ["x-small", "XS"], ["Extra Large", "XL"], ["2XL", "XXL"], ["Size: L", "L"]]) {
    assert.equal(normalizeSize(raw).canonical, want, raw);
  }
});

test("plus sizes are their own scale, never letters", () => {
  for (const raw of ["1X", "2X", "3X"]) {
    const s = normalizeSize(raw);
    assert.equal(s.kind, "plus");
    assert.equal(sizeMatches(s, "XL"), "no");
  }
});

test("a US numeric matches a letter only as INFERRED", () => {
  assert.equal(sizeMatches(normalizeSize("US 8"), "M"), "inferred");
  assert.equal(sizeMatches(normalizeSize("US 12"), "L"), "inferred");
  assert.equal(sizeMatches(normalizeSize("US 12"), "S"), "no");
  assert.equal(sizeMatches(normalizeSize("M"), "M"), "exact");
  assert.equal(sizeMatches(normalizeSize("M"), "S"), "no");
});

test("an unknown card size is unknown against any intent, never a mismatch", () => {
  assert.equal(sizeMatches(normalizeSize("X8"), "XS"), "unknown");
  assert.equal(sizeMatches(normalizeSize(""), "M"), "unknown");
});

test("the title's size word agrees with the card's size field on every fixture that has both", () => {
  // `... Size Large` next to size L, `Size XS` next to XS, `size 12` next to US 12.
  const word = /\bsize:?\s+(xxs|xs|s|m|l|xl|xxl|small|medium|large|x-small|\d{1,2})\b/i;
  let checked = 0;
  for (const c of cards) {
    const m = c.title.match(word);
    if (!m || c.size.confidence === "unknown") continue;
    const fromTitle = normalizeSize(m[1]);
    assert.equal(fromTitle.canonical, c.size.canonical, c.title);
    checked++;
  }
  assert.ok(checked >= 6, `only ${checked} fixtures carried a size word`);
});

// ------------------------------------------------------------ brand ----------
test("brand is read from the title because the card has no brand element", () => {
  assert.equal(fx.cardSelectors.brand, null);
  assert.equal(normalizeBrand("Rails Bretton Rosewood Mimi Hearts Print Blouse").canonical, "Rails");
  assert.equal(normalizeBrand("Madewell Women's Floral V-Neck Blouse").canonical, "Madewell");
  assert.equal(normalizeBrand("PRANA Organic Short Sleeve Katya Blouse").canonical, "Prana");
  assert.equal(normalizeBrand("Levi's Blouse").canonical, "Levi's");
  assert.equal(normalizeBrand("L'AGENCE Butter Yellow Tyler Blouse, M").canonical, "L'AGENCE");
});

test("a title with no known brand word is UNKNOWN, not 'no brand'", () => {
  assert.equal(normalizeBrand("Flattering blouse").confidence, "unknown");
  assert.equal(normalizeBrand("Blouse").confidence, "unknown");
});

test("a brand word inside another word does not match", () => {
  // `astr` must not fire on `pastry`; `fp` must not fire on `fpl`.
  assert.equal(normalizeBrand("Pastry chef blouse").confidence, "unknown");
});

test("about two thirds of the fixture titles name a brand the table knows", () => {
  const known = cards.filter((c) => c.brand.confidence === "title").length;
  assert.ok(known >= 24 && known <= 40, `known brands: ${known} of ${cards.length}`);
});

// ----------------------------------------------------------- colour ----------
test("colour families are read from title words, phrases before words", () => {
  assert.deepEqual([...coloursFromTitle("Light Pink Polka Dot Button Down Blouse")].sort(), ["blue", "multi", "pink"].sort().filter((x) => x !== "blue"));
});

test("colour synonyms map into families", () => {
  assert.ok(coloursFromTitle("Blush Floral Peplum Blouse").has("pink"));
  assert.ok(coloursFromTitle("Butter Yellow Tyler Blouse").has("yellow"));
  assert.ok(coloursFromTitle("Rust Button Front Blouse").has("brown"));
  assert.ok(coloursFromTitle("Bleached Lavender Blouse").has("purple"));
  assert.ok(coloursFromTitle("Rye Green Wildflower Top").has("green"));
  assert.ok(coloursFromTitle("Light Blue Polka Dot Top").has("blue"));
});

test("expanded vocabulary catches shades Poshmark's flat filter cannot", () => {
  assert.ok(coloursFromTitle("Aubergine Silk Blouse").has("purple"));
  assert.ok(coloursFromTitle("Cerulean Wrap Top").has("blue"));
  assert.ok(coloursFromTitle("Oxblood Leather Shell").has("red"));
  assert.ok(coloursFromTitle("Seafoam Ribbed Tank").has("green"));
  assert.ok(coloursFromTitle("Burnt Orange Peasant Top").has("orange"));
});

test("ambiguous first-name-ish colours only match in their phrase form", () => {
  // 'ruby red' is a colour; 'Ruby' alone is a name - do not match it.
  assert.ok(coloursFromTitle("Ruby Red Satin Cami").has("red"));
  assert.equal(coloursFromTitle("Ruby Wildflower Blouse").size, 0);
  // 'fawn' was removed entirely - it collided with the brand 'Gentle Fawn'.
  assert.equal(coloursFromTitle("Gentle Fawn Idyll Blouse Top").size, 0);
});

test("a title with no colour word is an EMPTY set - unknown, not colourless", () => {
  assert.equal(coloursFromTitle("Flattering blouse").size, 0);
  assert.equal(coloursFromTitle("Joie Blouse").size, 0);
});

test("14 of 48 fixture titles say nothing about colour - the case Tier 3 exists for", () => {
  // Measured, not assumed: I expected "more than half" and the fixture said 14.
  // Pattern words (floral, polka dot, print) count as a colour statement, so
  // most titles DO say something. The 14 silent ones are what a listing read
  // would resolve.
  const silent = cards.filter((c) => c.colours.size === 0).length;
  assert.equal(silent, 14, `${silent} of ${cards.length} silent`);
});

// ---------------------------------------------------------- verdict ----------
const family = { jason: { tops: ["M"] }, partner: { tops: ["S"] }, kid: { tops: ["XS"] } };

test("a size mismatch HIDES and says both sizes", () => {
  const v = verdict(parseCard({ title: "Rails Bretton Blouse", size: "L" }), intentFor(family, "partner", "tops"));
  assert.equal(v.state, "hide");
  assert.match(v.reasons[0], /size L, you asked for S/);
});

test("an exact size match SHOWS with no reasons", () => {
  const v = verdict(parseCard({ title: "Rails Bretton Blouse", size: "S" }), intentFor(family, "partner", "tops"));
  assert.deepEqual(v, { state: "show", reasons: [], notes: [] });
});

test("an unreadable size DIMS, never hides", () => {
  const v = verdict(parseCard({ title: "Umbrale Woman Rust Blouse Size XS", size: "X8" }), intentFor(family, "kid", "tops"));
  assert.equal(v.state, "dim");
  assert.match(v.reasons[0], /not readable/);
});

test("an inferred size SHOWS with a note", () => {
  const v = verdict(parseCard({ title: "Madewell Coral Floral Blouse", size: "US 8" }), intentFor(family, "jason", "tops"));
  assert.equal(v.state, "show");
  assert.match(v.notes[0], /likely fits M/);
});

test("'anyone' unions the family's sizes", () => {
  const i = intentFor(family, "anyone", "tops");
  assert.deepEqual([...i.sizes].sort(), ["M", "S", "XS"]);
  assert.equal(verdict(parseCard({ title: "Blouse", size: "XS" }), i).state, "show");
  assert.equal(verdict(parseCard({ title: "Blouse", size: "XL" }), i).state, "hide");
});

test("a brand constraint hides a known other brand and dims an unknown one", () => {
  const i = intentFor(family, "jason", "tops", { brands: ["Rails"] });
  assert.equal(verdict(parseCard({ title: "Madewell blouse", size: "M" }), i).state, "hide");
  assert.equal(verdict(parseCard({ title: "Flattering blouse", size: "M" }), i).state, "dim");
  assert.equal(verdict(parseCard({ title: "Rails Thea Rose Blouse", size: "M" }), i).state, "show");
});

test("a colour constraint hides a contradicting colour and dims silence", () => {
  const i = intentFor(family, "partner", "tops", { colours: ["pink"] });
  assert.equal(verdict(parseCard({ title: "NBD Black Sheer Tie-Front Blouse", size: "S" }), i).state, "hide");
  assert.equal(verdict(parseCard({ title: "Venus Blouse", size: "S" }), i).state, "dim");
  assert.equal(verdict(parseCard({ title: "saltwater LUXE Blush Floral Peplum Blouse", size: "S" }), i).state, "show");
});

test("a hide on one attribute wins over an unknown on another", () => {
  const i = intentFor(family, "partner", "tops", { colours: ["pink"] });
  const v = verdict(parseCard({ title: "Venus Blouse", size: "L" }), i); // size wrong, colour unknown
  assert.equal(v.state, "hide");
});

test("the whole fixture under one shopper: nothing is silently dropped", () => {
  const i = intentFor(family, "partner", "tops");
  const states = cards.map((c) => verdict(c, i).state);
  const n = (s) => states.filter((x) => x === s).length;
  assert.equal(n("show") + n("dim") + n("hide"), cards.length);
  // Every exact S shows, plus the one `US 6` card, which is an INFERRED S.
  const exactS = cards.filter((c) => c.size.canonical === "S").length;
  const inferredS = cards.filter((c) => c.size.kind === "us" && ["US 4", "US 6"].includes(c.size.canonical)).length;
  assert.equal(n("show"), exactS + inferredS, `every S shows (${exactS} exact + ${inferredS} inferred)`);
  assert.equal(n("dim"), 1, "only the X8 card dims");
  for (const [c, s] of cards.map((c, k) => [c, states[k]])) {
    if (s === "hide") assert.ok(verdict(c, i).reasons.length, "every hide has a reason");
  }
});
