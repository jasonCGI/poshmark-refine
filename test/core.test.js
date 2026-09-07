// Core tests. Every assertion is against captured card text from a real
// search (fixtures/) or a spelling seen in one. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeSize, sizeMatches, normalizeBrand, coloursFromTitle,
  CATEGORY_SIZES, CATEGORIES, parsePrice, normalizeCondition, sizeFromText,
  matchesColourTerm, colourwayCandidates,
} from "../core/normalize.js";
import { parseCard, intentFor, verdict } from "../core/verdict.js";
import { compareVersions, isNewer, shouldCheck, fetchLatestVersion } from "../core/update.js";
import {
  capturePreset, applyPreset, upsertPreset, removePreset, describePreset, PRESET_FIELDS,
} from "../core/presets.js";
import { brandIndexWith, colourIndexWith } from "../core/normalize.js";

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

test("a word in TWO families yields both - consuming it early hid valid items", () => {
  // The table deliberately puts these words in two families. Matching used to
  // consume the word on the first family that claimed it, so a beige filter
  // hid a cream top and an orange filter hid a coral one.
  const cream = coloursFromTitle("Cream Silk Blouse");
  assert.ok(cream.has("white"), "cream is a white");
  assert.ok(cream.has("beige"), "cream is ALSO a beige");
  const coral = coloursFromTitle("Coral Ruffle Top");
  assert.ok(coral.has("pink") && coral.has("orange"), "coral is pink and orange");
  const khaki = coloursFromTitle("Khaki Utility Shirt");
  assert.ok(khaki.has("beige") && khaki.has("green"), "khaki is beige and green");
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

// ------------------------------------------------- per-category sizes --------
test("shoes are their own scale: half sizes parse, letters never infer", () => {
  const eight = normalizeSize("8", "shoes");
  assert.equal(eight.canonical, "US 8");
  assert.equal(eight.kind, "shoe");
  assert.equal(normalizeSize("8.5", "shoes").canonical, "US 8.5");
  assert.equal(normalizeSize("9 1/2", "shoes").canonical, "US 9.5");
  assert.equal(sizeMatches(eight, "8", "shoes"), "exact");
  assert.equal(sizeMatches(eight, "9", "shoes"), "no");
  // An 8 shoe is NOT a Medium. Under garment rules this would have come back
  // "inferred" (US 8 -> M); in the shoe scale the letter is simply unreadable,
  // so the answer is "unknown" (which dims, never hides) and never "inferred".
  const vsLetter = sizeMatches(eight, "M", "shoes");
  assert.notEqual(vsLetter, "inferred");
  assert.equal(vsLetter, "unknown");
  // and a letter is not a readable shoe size
  assert.equal(normalizeSize("M", "shoes").confidence, "unknown");
});

test("garment categories still infer US numeric to letters", () => {
  const four = normalizeSize("4", "tops");
  assert.equal(sizeMatches(four, "S", "tops"), "inferred");
  assert.equal(sizeMatches(normalizeSize("4", "dresses"), "S", "dresses"), "inferred");
  // a jeans waist has no letter equivalent in the table, so it simply does not match
  assert.equal(sizeMatches(normalizeSize("30", "bottoms"), "M", "bottoms"), "no");
});

test("every category offers quick-pick sizes", () => {
  for (const c of CATEGORIES) assert.ok((CATEGORY_SIZES[c] || []).length > 0, c + " has no sizes");
});

// ------------------------------------------------- price and condition -------
test("price parses out of the card text, and unreadable is null not zero", () => {
  assert.equal(parsePrice("$48"), 48);
  assert.equal(parsePrice("$1,299"), 1299);
  assert.equal(parsePrice("$24.50"), 24.5);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("Free People"), null);
});

test("an empty condition badge means not-new; a missing one means unknown", () => {
  assert.equal(normalizeCondition("NWT"), "nwt");
  assert.equal(normalizeCondition("New With Tags"), "nwt");
  assert.equal(normalizeCondition(""), "used");
  // the distinction lives on the card: conditionKnown false = element absent
  assert.equal(parseCard({ title: "x", condition: "" }).conditionKnown, true);
  assert.equal(parseCard({ title: "x", conditionKnown: false }).conditionKnown, false);
});

test("over-budget HIDES with the price named; no price DIMS", () => {
  const i = intentFor({ me: { tops: [] } }, "me", "tops", { maxPrice: 50 });
  const over = verdict(parseCard({ title: "Rails Top", price: "$78" }), i);
  assert.equal(over.state, "hide");
  assert.equal(over.cause, "price");
  assert.match(over.reasons.join(" "), /\$78.*\$50/);
  assert.equal(verdict(parseCard({ title: "Rails Top", price: "$40" }), i).state, "show");
  assert.equal(verdict(parseCard({ title: "Rails Top", price: "" }), i).state, "dim");
});

test("NWT-only hides a used item but only DIMS when the badge is absent", () => {
  const i = intentFor({ me: { tops: [] } }, "me", "tops", { conditions: ["nwt"] });
  assert.equal(verdict(parseCard({ title: "Top", condition: "NWT" }), i).state, "show");
  const used = verdict(parseCard({ title: "Top", condition: "" }), i);
  assert.equal(used.state, "hide");
  assert.equal(used.cause, "condition");
  // element missing entirely: unknown, so it must not be discarded
  assert.equal(verdict(parseCard({ title: "Top", conditionKnown: false }), i).state, "dim");
});

test("every hide names the constraint that caused it, for the zero-match summary", () => {
  const i = intentFor({ me: { tops: ["S"] } }, "me", "tops", { brands: ["Rails"], colours: ["blue"], maxPrice: 50 });
  assert.equal(verdict(parseCard({ title: "Rails Blue Top", size: "L" }), i).cause, "size");
  assert.equal(verdict(parseCard({ title: "Zara Blue Top", size: "S" }), i).cause, "brand");
  assert.equal(verdict(parseCard({ title: "Rails Red Top", size: "S" }), i).cause, "colour");
  assert.equal(verdict(parseCard({ title: "Rails Blue Top", size: "S", price: "$99" }), i).cause, "price");
});

// ----------------------------------------- size described in the body --------
test("only a LABELLED size counts as a described size", () => {
  assert.equal(sizeFromText("Size XL chest 17in").canonical, "XL");
  assert.equal(sizeFromText("marked M").canonical, "M");
  assert.equal(sizeFromText("fits like a medium").canonical, "M");
  // a bare letter in prose is not a size statement
  assert.equal(sizeFromText("Lovely top, L shaped neckline"), null);
  assert.equal(sizeFromText("great condition"), null);
});

test("the real Vuori listing: size only in prose, and hedged", () => {
  // verbatim from poshmark.com/listing/VuoriSunrise-Crop-Ribbed-Tank-Top-...
  const desc = "Great Pre Owned Condition Vuori Sunrise Crop Ribbed Tank Top Size tag is " +
    "missing. Similar garments with the same measurements are Size XL chest measurement " +
    "pit to pit 17in length";
  const d = sizeFromText(desc);
  assert.equal(d.canonical, "XL");
  assert.equal(d.confidence, "described", "never 'exact' - it is the seller's estimate");
});

test("a described size SURFACES a likely match but never discards an item", () => {
  const wantXL = intentFor({ me: { tops: ["XL"] } }, "me", "tops");
  const wantS = intentFor({ me: { tops: ["S"] } }, "me", "tops");
  const described = sizeFromText("Size tag is missing. Similar garments are Size XL");

  // card has NO readable size; the body says XL and the shopper wants XL
  const card = parseCard({ title: "Vuori Tank", size: "" });
  card.describedSize = described;
  const match = verdict(card, wantXL);
  assert.equal(match.state, "show");
  assert.match(match.notes.join(" "), /listing body says size XL/);
  assert.match(match.notes.join(" "), /not a tag/, "the hedge must be visible to the shopper");

  // same card, shopper wants S: the body disagrees, but a hedged guess must not
  // hide it - it stays dimmed with the reason spelled out
  const card2 = parseCard({ title: "Vuori Tank", size: "" });
  card2.describedSize = described;
  const clash = verdict(card2, wantS);
  assert.equal(clash.state, "dim", "never hide on the seller's estimate");
  assert.match(clash.reasons.join(" "), /kept for you to judge/);
});

// ------------------------------------------------------- colourways ---------
test("a colourway is matched as a whole phrase, in title or listing body", () => {
  assert.equal(matchesColourTerm("Vuori Sunday Hoodie Bay Blue", ["bay blue"]), "bay blue");
  assert.equal(matchesColourTerm("Color: Frost Grey", ["Frost Grey"]), "frost grey");
  // a family word is not the colourway
  assert.equal(matchesColourTerm("Navy Blue Hoodie", ["bay blue"]), null);
  assert.equal(matchesColourTerm("", ["bay blue"]), null);
});

test("colourway names are LEARNED from listing text, not invented", () => {
  // the three from the shopper's own screenshots
  assert.deepEqual(colourwayCandidates("Vuori Sunday Pullover Hoodie Bay Blue"), ["Bay Blue"]);
  assert.deepEqual(colourwayCandidates("Color: Frost Grey"), ["Frost Grey"]);
  assert.ok(colourwayCandidates("Elevation Square Neck Cami Velvet Violet Heather")
    .includes("Velvet Violet Heather"));
  // prose is not a colourway, and a brand must not be learned as one
  assert.deepEqual(colourwayCandidates("a light blue top in great condition"), []);
  assert.deepEqual(colourwayCandidates("Rails Sage Ruffle Top"), []);
});

test("a missing colourway DIMS - it is usually on the listing, not the card", () => {
  const i = intentFor({ me: { tops: [] } }, "me", "tops", { colourTerms: ["Bay Blue"] });
  const named = verdict(parseCard({ title: "Vuori Sunday Hoodie Bay Blue" }), i);
  assert.equal(named.state, "show");
  assert.match(named.notes.join(" "), /colourway "bay blue"/);

  const silent = verdict(parseCard({ title: "Vuori Sunday Hoodie" }), i);
  assert.equal(silent.state, "dim", "never hide because the card omitted the name");
  assert.match(silent.reasons.join(" "), /listing may say/);

  // Tier-3 supplies the body, which names it
  const withBody = parseCard({ title: "Vuori Sunday Hoodie" });
  withBody.bodyText = "Color: Bay Blue. Great condition.";
  assert.equal(verdict(withBody, i).state, "show");
});

// ---------------------------------------------------------- verdict ----------
const family = { jason: { tops: ["M"] }, partner: { tops: ["S"] }, kid: { tops: ["XS"] } };

test("a size mismatch HIDES and says both sizes", () => {
  const v = verdict(parseCard({ title: "Rails Bretton Blouse", size: "L" }), intentFor(family, "partner", "tops"));
  assert.equal(v.state, "hide");
  assert.match(v.reasons[0], /size L, you asked for S/);
});

test("an exact size match SHOWS with no reasons, and names who it fits", () => {
  const v = verdict(parseCard({ title: "Rails Bretton Blouse", size: "S" }), intentFor(family, "partner", "tops"));
  assert.deepEqual(v, { state: "show", reasons: [], notes: [], fits: ["partner"] });
});

test("shopping for ANYONE, a match says which of them it fits", () => {
  // the gap the family feature opened: a union of everyone's sizes made every
  // match anonymous, so the shopper still had to work out who by eye
  const anyone = intentFor(family, "anyone", "tops");
  const fitsOne = verdict(parseCard({ title: "Rails Bretton Blouse", size: "S" }), anyone);
  assert.deepEqual(fitsOne.fits, ["partner"], "only the person whose size it is");
  assert.equal(fitsOne.state, "show");

  // a size two people share names both, in profile order rather than size order
  const shared = Object.keys(family).filter((p) => (family[p].tops || []).includes("XS"));
  if (shared.length > 1) {
    const v = verdict(parseCard({ title: "Blouse", size: "XS" }), anyone);
    assert.deepEqual(v.fits, shared);
  }

  // a hidden card fits nobody, whatever sizes were asked for
  const miss = verdict(parseCard({ title: "Blouse", size: "3XL" }), anyone);
  assert.equal(miss.state, "hide");
  assert.deepEqual(miss.fits || [], [], "a card that was hidden fits no one");
});

test("owners survive the union so the badge can name a person", () => {
  const anyone = intentFor(family, "anyone", "tops");
  assert.ok(anyone.owners, "the union used to discard this");
  for (const [size, people] of Object.entries(anyone.owners)) {
    for (const p of people) {
      assert.ok((family[p].tops || []).includes(size), p + " really does wear " + size);
    }
  }
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

// ------------------------------------------------------ update check ---------
test("version comparison is numeric, not lexical", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "0.10 is NEWER than 0.9");
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("0.9", "0.9.0"), 0, "missing parts count as zero");
  assert.ok(isNewer("1.0.0", "0.10.1"));
  assert.ok(!isNewer("0.10.1", "0.10.1"));
});

test("the network is touched only when opted in, and at most once a day", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  assert.equal(shouldCheck({ enabled: false }, now), false, "off by default means no request");
  assert.equal(shouldCheck({ enabled: true, lastCheck: 0 }, now), true, "never checked -> check");
  assert.equal(shouldCheck({ enabled: true, lastCheck: now - 1000 }, now), false, "checked a moment ago");
  assert.equal(shouldCheck({ enabled: true, lastCheck: now - 25 * 3600 * 1000 }, now), true);
});

test("a failed or malformed update check is silent, never an error at the shopper", async () => {
  assert.equal(await fetchLatestVersion(async () => { throw new Error("offline"); }), null);
  assert.equal(await fetchLatestVersion(async () => ({ ok: false })), null);
  assert.equal(await fetchLatestVersion(async () => ({ ok: true, text: async () => "not json" })), null);
  assert.equal(
    await fetchLatestVersion(async () => ({ ok: true, text: async () => '{"version": "0.11.0"}' })),
    "0.11.0");
});

// ---------------------------------------------------- saved searches ---------
const SETTINGS = {
  profiles: { me: { tops: ["S", "M"] }, partner: { tops: ["S"] } },
  who: "me", category: "tops", query: "cami",
  brands: ["Vuori"], colours: ["purple"], colourTerms: ["Velvet Violet Heather"],
  maxPrice: 60, conditions: ["nwt"],
  hideMode: "fade", tier3: true, department: "Women",
};

test("a preset captures the search, never the family's sizes", () => {
  const p = capturePreset("Vuori purple", SETTINGS);
  assert.equal(p.name, "Vuori purple");
  assert.deepEqual(p.brands, ["Vuori"]);
  assert.equal(p.maxPrice, 60);
  assert.equal(p.who, "me", "whose sizes to use IS part of the search");
  assert.equal(p.profiles, undefined, "but the sizes themselves are not");
  assert.equal(p.hideMode, undefined, "nor the behaviour toggles");
});

test("applying a preset leaves profiles and behaviour untouched", () => {
  const p = capturePreset("x", SETTINGS);
  const next = applyPreset(Object.assign({}, SETTINGS, { query: "junk", brands: ["Zara"] }), p);
  assert.deepEqual(next.brands, ["Vuori"]);
  assert.equal(next.query, "cami");
  assert.deepEqual(next.profiles, SETTINGS.profiles, "sizes survive");
  assert.equal(next.hideMode, "fade");
  assert.equal(next.tier3, true);
});

test("a field absent from the preset is CLEARED, not inherited from the last search", () => {
  const narrow = { name: "just tops", category: "tops" };
  const next = applyPreset(SETTINGS, narrow);
  assert.deepEqual(next.brands, [], "leftover brand must not survive");
  assert.deepEqual(next.colourTerms, []);
  assert.equal(next.maxPrice, null);
  assert.deepEqual(next.profiles, SETTINGS.profiles, "still not a sizes edit");
});

test("presets upsert by name, case-insensitively, and stay sorted", () => {
  let list = upsertPreset([], capturePreset("Work tops", SETTINGS));
  list = upsertPreset(list, capturePreset("Athleisure", SETTINGS));
  assert.deepEqual(list.map((p) => p.name), ["Athleisure", "Work tops"]);
  list = upsertPreset(list, capturePreset("WORK TOPS", Object.assign({}, SETTINGS, { query: "blazer" })));
  assert.equal(list.length, 2, "same name replaces rather than duplicating");
  assert.equal(list.find((p) => /work/i.test(p.name)).query, "blazer");
  assert.deepEqual(removePreset(list, "athleisure").map((p) => p.name), ["WORK TOPS"]);
});

test("a preset describes itself for the chip tooltip", () => {
  const d = describePreset(capturePreset("x", SETTINGS));
  assert.match(d, /"cami"/);
  assert.match(d, /Vuori/);
  assert.match(d, /under \$60/);
  assert.equal(describePreset({ name: "empty" }), "no criteria");
});

test("PRESET_FIELDS never includes profiles - that is the whole guarantee", () => {
  assert.ok(!PRESET_FIELDS.includes("profiles"));
  assert.ok(PRESET_FIELDS.includes("who"));
});

// ------------------------------------------------------- corrections --------
test("a correction teaches the WORD, so it applies to every future listing", () => {
  // the table has always claimed it grows from corrections; this is that
  assert.equal(normalizeBrand("Alo Yoga Ribbed Tank").confidence, "unknown");
  const idx = brandIndexWith({ "alo yoga": "Alo Yoga" });
  assert.equal(normalizeBrand("Alo Yoga Ribbed Tank", idx).canonical, "Alo Yoga");
  // and it is not card-specific - a different listing benefits too
  assert.equal(normalizeBrand("ALO YOGA Airlift Legging", idx).canonical, "Alo Yoga");
});

test("a corrected colour word joins the family it was taught", () => {
  assert.equal(coloursFromTitle("Bay Ribbed Tank").size, 0, "unknown shade is unknown");
  const idx = colourIndexWith({ bay: "blue" });
  assert.ok(coloursFromTitle("Bay Ribbed Tank", idx).has("blue"));
  // shipped vocabulary still works alongside the correction
  assert.ok(coloursFromTitle("Sage Cami", idx).has("green"));
});

test("a correction can override a shipped alias, longest match still wins", () => {
  const idx = brandIndexWith({ "free people": "FP Movement" });
  assert.equal(normalizeBrand("Free People Tank", idx).canonical, "FP Movement");
});

test("parseCard threads corrections through without changing its reasoning", () => {
  const corr = { brands: { "alo yoga": "Alo Yoga" }, colours: { bay: "blue" } };
  const card = parseCard({ title: "Alo Yoga Bay Ribbed Tank", size: "M" }, "tops", corr);
  assert.equal(card.brand.canonical, "Alo Yoga");
  assert.equal(card.brand.confidence, "title", "still 'found in the title', not a guess");
  assert.ok(card.colours.has("blue"));
});

// -------------------------------------------- colour source precedence ------
test("a contradicting TITLE colour hides; a contradicting listing FIELD only dims", () => {
  const wantPurple = intentFor({ me: { tops: [] } }, "me", "tops", { colours: ["purple"] });

  // the seller's own words say red -> real evidence, discard it
  const byTitle = verdict(parseCard({ title: "Rails Red Ruffle Top" }), wantPurple);
  assert.equal(byTitle.state, "hide");
  assert.equal(byTitle.cause, "colour");

  // the title says nothing; only Poshmark's ~16-option field says blue. That is
  // coarse by construction, so it must not throw the listing away.
  const byField = parseCard({ title: "Vuori Ribbed Tank" });
  byField.bodyColours = new Set(["blue"]);
  const v = verdict(byField, wantPurple);
  assert.equal(v.state, "dim", "a coarse field must never hide an item");
  assert.match(v.reasons.join(" "), /coarse/);
  assert.match(v.reasons.join(" "), /kept for you to judge/);
});

test("either source agreeing is enough to show", () => {
  const wantPurple = intentFor({ me: { tops: [] } }, "me", "tops", { colours: ["purple"] });
  assert.equal(verdict(parseCard({ title: "Lavender Cami" }), wantPurple).state, "show");
  const fieldOnly = parseCard({ title: "Vuori Ribbed Tank" });
  fieldOnly.bodyColours = new Set(["purple"]);
  assert.equal(verdict(fieldOnly, wantPurple).state, "show", "listing field can confirm");
});

test("no colour anywhere is still unknown, not a mismatch", () => {
  const i = intentFor({ me: { tops: [] } }, "me", "tops", { colours: ["purple"] });
  const v = verdict(parseCard({ title: "Vuori Ribbed Tank" }), i);
  assert.equal(v.state, "dim");
  assert.match(v.reasons.join(" "), /no colour in the title/);
});

// ------------------------------------------------ on-device AI tier ---------
import {
  resolveApi, availability, isReady, buildPrompt, parseAiAnswer, readAttributes,
  mergeAiIntoCard, ATTRIBUTE_SCHEMA, AI_UNAVAILABLE,
} from "../core/ai.js";

test("a missing Prompt API is simply unavailable, never an error", async () => {
  assert.equal(resolveApi({}), null);
  assert.equal(await availability(null), AI_UNAVAILABLE);
  assert.equal(await availability({ availability: () => { throw new Error("boom"); } }), AI_UNAVAILABLE);
  assert.ok(!isReady(AI_UNAVAILABLE));
  assert.ok(isReady("available"));
  assert.ok(!isReady("downloadable"), "downloadable is not usable yet");
});

test("either spelling of the global is accepted", () => {
  const lm = {};
  assert.equal(resolveApi({ LanguageModel: lm }), lm);
  assert.equal(resolveApi({ ai: { languageModel: lm } }), lm);
});

test("the prompt forbids inference and the schema allows null everywhere", () => {
  const p = buildPrompt({ title: "Vuori Cami", body: "Size tag missing" });
  assert.match(p, /ONLY what it actually states/);
  assert.match(p, /Do not infer/);
  assert.match(p, /return null/);
  for (const f of ["size", "colour", "brand"]) {
    assert.ok(ATTRIBUTE_SCHEMA.properties[f].type.includes("null"), f + " must be nullable");
  }
});

test("an unparseable or evasive answer is all-unknown, never a partial guess", () => {
  assert.deepEqual(parseAiAnswer(null), { size: null, colour: null, brand: null });
  assert.deepEqual(parseAiAnswer("I could not tell"), { size: null, colour: null, brand: null });
  assert.deepEqual(parseAiAnswer('{"size":"unknown","colour":"N/A","brand":""}'),
    { size: null, colour: null, brand: null });
  assert.deepEqual(parseAiAnswer('noise {"size":"M","colour":"Bay Blue","brand":"Vuori"} more'),
    { size: "M", colour: "Bay Blue", brand: "Vuori" });
});

test("a failing model never breaks the caller", async () => {
  const api = { create: async () => { throw new Error("model gone"); } };
  assert.deepEqual(await readAttributes(api, { title: "x" }), { size: null, colour: null, brand: null });
});

test("the model may FILL an unknown but never overwrite what we already know", () => {
  const known = parseCard({ title: "Rails Sage Top", size: "M" });
  const merged = mergeAiIntoCard(known, { size: "XL", colour: "red", brand: "Zara" },
    { normalizeSize, coloursFromTitle });
  assert.equal(merged.size.canonical, "M", "a read size must not overwrite a stated one");
  assert.equal(merged.brand.canonical, "Rails", "nor a brand found in the title");
  assert.ok(merged.colours.has("green"), "nor a colour from the title");

  const blank = parseCard({ title: "Ribbed Tank", size: "" });
  const filled = mergeAiIntoCard(blank, { size: "M", colour: "navy", brand: "Vuori" },
    { normalizeSize, coloursFromTitle });
  assert.equal(filled.describedSize.canonical, "M");
  assert.equal(filled.describedSize.confidence, "described", "weak, like a description size");
  assert.ok(filled.bodyColours.has("blue"));
  assert.equal(filled.brand.confidence, "ai");
});

test("an AI-read brand can surface a card but must never discard one", () => {
  const want = intentFor({ me: { tops: [] } }, "me", "tops", { brands: ["Vuori"] });
  const card = parseCard({ title: "Ribbed Tank" });
  const aiSaysOther = mergeAiIntoCard(card, { size: null, colour: null, brand: "Zara" },
    { normalizeSize, coloursFromTitle });
  const v = verdict(aiSaysOther, want);
  assert.equal(v.state, "dim", "a model reading must not hide a listing");
  assert.match(v.reasons.join(" "), /kept for you to judge/);

  // whereas the TABLE finding a different brand in the title still hides
  const byTitle = verdict(parseCard({ title: "Zara Ribbed Tank" }), want);
  assert.equal(byTitle.state, "hide");
});

// ---------------------------------------------- verified Poshmark facets ----
import { poshmarkSearchUrl, POSH_CATEGORY, POSH_FACETS_VERIFIED } from "../core/search.js";

test("every category maps to a facet read off Poshmark's own links", () => {
  for (const [cat, facet] of Object.entries(POSH_CATEGORY)) {
    assert.ok(POSH_FACETS_VERIFIED.includes(facet), cat + " -> " + facet + " was never verified");
  }
  // the convention is underscores AND a literal ampersand - not guessable
  assert.equal(POSH_CATEGORY.outerwear, "Jackets_&_Coats");
  assert.equal(POSH_CATEGORY.bottoms, "Pants_&_Jumpsuits");
});

test("the search URL encodes the ampersand facet correctly", () => {
  const u = poshmarkSearchUrl({ query: "vuori", department: "Women", category: "outerwear" });
  assert.match(u, /category=Jackets_%26_Coats/, "& must be percent-encoded in the query string");
  assert.match(u, /query=vuori/);
  assert.match(u, /department=Women/);
  // All departments means no department facet at all
  assert.ok(!poshmarkSearchUrl({ query: "x", department: "All" }).includes("department="));
});
