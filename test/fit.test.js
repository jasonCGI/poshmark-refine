// Tier 4 - fit memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EVIDENCE, fitEntry, recordFit, learnedSize, sizesWithFit, explainFit, forgetFit,
  canonicalBrand, migrateLedger,
} from "../core/fit.js";

const add = (l, person, brand, category, size, fits) =>
  recordFit(l, { person, brand, category, size, fits });

test("an incomplete outcome is refused rather than half-recorded", () => {
  assert.equal(fitEntry({ person: "", brand: "Levi's", category: "bottoms", size: "26" }), null);
  assert.equal(fitEntry({ person: "me", brand: "", category: "bottoms", size: "26" }), null);
  assert.equal(fitEntry({ person: "me", brand: "Levi's", category: "bottoms", size: "" }), null);
  assert.deepEqual(recordFit(null, { person: "" }), [], "a refused entry does not corrupt the ledger");
});

test("one outcome is an anecdote, not a lesson", () => {
  let l = add([], "me", "Levi's", "bottoms", "28", true);
  assert.equal(learnedSize(l, "me", "Levi's", "bottoms"), null,
    "a single success must not rewrite a size profile the shopper set deliberately");
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  assert.equal(learnedSize(l, "me", "Levi's", "bottoms").size, "28",
    "two agreeing outcomes is the threshold");
  assert.equal(MIN_EVIDENCE, 2);
});

test("a size that both fitted and failed is noise, and is not taught", () => {
  let l = [];
  for (let i = 0; i < 3; i++) l = add(l, "me", "Vuori", "tops", "M", true);
  l = add(l, "me", "Vuori", "tops", "M", false);
  assert.equal(learnedSize(l, "me", "Vuori", "tops"), null,
    "three fits and one miss is a garment that varies, not a rule");
});

test("learning is per person, per brand, per category - never leaked across", () => {
  let l = [];
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  assert.equal(learnedSize(l, "me", "Levi's", "bottoms").size, "28");
  assert.equal(learnedSize(l, "partner", "Levi's", "bottoms"), null, "not another person's body");
  assert.equal(learnedSize(l, "me", "Rails", "bottoms"), null, "not another brand's cut");
  assert.equal(learnedSize(l, "me", "Levi's", "tops"), null, "jeans teach nothing about shirts");
  assert.equal(learnedSize(l, "me", "LEVI'S", "bottoms").size, "28", "brand matching ignores case");
});

test("a learned size WIDENS the search and never replaces what the shopper set", () => {
  let l = [];
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  l = add(l, "me", "Levi's", "bottoms", "28", true);

  const out = sizesWithFit(["26"], l, "me", "Levi's", "bottoms");
  assert.deepEqual(out.sizes, ["26", "28"], "their stated size stays in the set");
  assert.equal(out.added.size, "28");
  assert.match(explainFit(out.added, "Levi's"), /28 in Levi's fitted 2 times/);

  // nothing learned: the set is untouched and nothing is claimed
  const none = sizesWithFit(["26"], [], "me", "Levi's", "bottoms");
  assert.deepEqual(none.sizes, ["26"]);
  assert.equal(none.added, null);

  // already asked for: no duplicate, and nothing to explain
  const dupe = sizesWithFit(["28"], l, "me", "Levi's", "bottoms");
  assert.deepEqual(dupe.sizes, ["28"]);
  assert.equal(dupe.added, null);
});

test("the ledger stays inspectable and an entry can be forgotten", () => {
  let l = [];
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  l = add(l, "me", "Levi's", "bottoms", "28", true);
  assert.equal(l.length, 2, "a flat list, so the shopper can see what was learned and from what");
  assert.ok(l[0].at, "each outcome is timestamped");

  const fewer = forgetFit(l, l[0].id);
  assert.equal(fewer.length, 1);
  assert.equal(learnedSize(fewer, "me", "Levi's", "bottoms"), null,
    "removing evidence removes the lesson, rather than leaving a conclusion with no support");
});

// --- fit memory inside the verdict ---------------------------------------
import { parseCard, intentFor, verdict } from "../core/verdict.js";

const family = { me: { bottoms: ["26"], tops: ["S"] }, partner: { bottoms: ["30"], tops: ["M"] } };
const twice = (person, brand, category, size) => {
  let l = [];
  for (let i = 0; i < 2; i++) l = recordFit(l, { person, brand, category, size, fits: true });
  return l;
};

test("a learned size surfaces a listing the stated size would have hidden", () => {
  const card = parseCard({ title: "Levi's 501 Original Straight Leg Jeans", size: "28" });
  const plain = verdict(card, intentFor(family, "me", "bottoms"));
  assert.equal(plain.state, "hide", "28 is not the 26 they asked for");

  const learned = verdict(card, intentFor(family, "me", "bottoms",
    { fitLedger: twice("me", "Levi's", "bottoms", "28") }));
  assert.equal(learned.state, "show");
  assert.match(learned.notes.join(" "), /28 in Levi's fitted 2 times, so this size is included/,
    "a listing they did not ask for owes them an explanation");
});

test("fit memory never HIDES - it only ever widens", () => {
  const card = parseCard({ title: "Levi's 501 Jeans", size: "26" });
  const v = verdict(card, intentFor(family, "me", "bottoms",
    { fitLedger: twice("me", "Levi's", "bottoms", "28") }));
  assert.equal(v.state, "show", "learning that 28 fits must not disqualify their stated 26");
});

test("one person's history does not widen another person's search", () => {
  const card = parseCard({ title: "Levi's 501 Jeans", size: "28" });
  const ledger = twice("me", "Levi's", "bottoms", "28");
  assert.equal(verdict(card, intentFor(family, "partner", "bottoms", { fitLedger: ledger })).state, "hide");

  // shopping for anyone, the size is added AND attributed to the right person
  const any = verdict(card, intentFor(family, "anyone", "bottoms", { fitLedger: ledger }));
  assert.equal(any.state, "show");
  assert.deepEqual(any.fits, ["me"], "learned from me, so it fits me - not the household");
});

test("the shared intent is not mutated by judging a card", () => {
  const intent = intentFor(family, "me", "bottoms", { fitLedger: twice("me", "Levi's", "bottoms", "28") });
  const before = JSON.stringify(intent.owners);
  verdict(parseCard({ title: "Levi's 501 Jeans", size: "28" }), intent);
  assert.equal(JSON.stringify(intent.owners), before,
    "one card's learned size must not leak onto every card judged after it");
  // and a different brand is unaffected by what Levi's taught us
  const other = verdict(parseCard({ title: "Rails Bretton Jeans", size: "28" }), intent);
  assert.equal(other.state, "hide", "Levi's cut says nothing about Rails");
});


// --- Codex review 2026-09-08 -----------------------------------------------

test("F2: an outcome is deleted by identity, never by position", () => {
  let l = [];
  for (const size of ["M", "L", "XL"]) l = add(l, "me", "Vuori", "tops", size, true);
  const targetId = l[1].id;                       // the L
  // another settings page removed the M in between; the rendered list is stale
  const elsewhere = forgetFit(l, l[0].id);
  const after = forgetFit(elsewhere, targetId);
  assert.deepEqual(after.map((e) => e.size), ["XL"], "the L went, not whatever shifted into slot 1");
  assert.ok(l.every((e) => e.id), "every outcome carries a stable id");
  assert.equal(new Set(l.map((e) => e.id)).size, 3, "and the ids are distinct");
});

test("F3: a brand typed as an alias is learned under its canonical name", () => {
  assert.equal(canonicalBrand("Levis"), "Levi's");
  assert.equal(canonicalBrand("  levi's  "), "Levi's");
  assert.equal(canonicalBrand("Some Unknown Label"), "Some Unknown Label", "unknown brands stay learnable");
  assert.equal(canonicalBrand(""), "");

  // the reported failure: settings showed a lesson the verdict could never use
  let l = [];
  for (let i = 0; i < 2; i++) l = recordFit(l, { person: "me", brand: "Levis", category: "tops", size: "M", fits: true });
  assert.equal(learnedSize(l, "me", "Levi's", "tops").size, "M",
    "recorded as Levis, found as Levi's - which is how cards parse");
});

test("F3: an older ledger is migrated rather than silently ignored", () => {
  const legacy = [
    { person: "me", brand: "Levis", category: "tops", size: "m", fits: true, at: 1 },
    { person: "me", brand: "Levis", category: "tops", size: "m", fits: true, at: 2 },
  ];
  const fixed = migrateLedger(legacy);
  assert.equal(fixed.length, 2);
  assert.ok(fixed.every((e) => e.id), "ids are backfilled");
  assert.equal(learnedSize(fixed, "me", "Levi's", "tops").size, "M");
  assert.deepEqual(migrateLedger(migrateLedger(legacy)).map((e) => e.brand), ["Levi's", "Levi's"],
    "idempotent - migrating twice does not re-canonicalise into something else");
});

test("F4: a size another person already contributed is still THIS person's lesson", () => {
  const household = { alice: { tops: ["S"] }, bob: { tops: ["M"] }, cara: { tops: ["L"] } };
  // Alice learns L, which Cara already wears
  let l = [];
  for (let i = 0; i < 2; i++) l = recordFit(l, { person: "alice", brand: "Vuori", category: "tops", size: "L", fits: true });

  const v = verdict(parseCard({ title: "Vuori Pullover", size: "L" }), intentFor(household, "anyone", "tops", { fitLedger: l }));
  assert.equal(v.state, "show");
  assert.deepEqual(v.fits.sort(), ["alice", "cara"],
    "Cara wears L outright and Alice learned it - dropping Alice named the wrong person");
});

test("F4: one person's lesson is not overwritten by the next person's", () => {
  const household = { alice: { tops: ["S"] }, bob: { tops: ["M"] } };
  let l = [];
  for (let i = 0; i < 2; i++) l = recordFit(l, { person: "alice", brand: "Vuori", category: "tops", size: "XL", fits: true });
  for (let i = 0; i < 2; i++) l = recordFit(l, { person: "bob", brand: "Vuori", category: "tops", size: "XXL", fits: true });

  const v = verdict(parseCard({ title: "Vuori Pullover", size: "XL" }), intentFor(household, "anyone", "tops", { fitLedger: l }));
  assert.deepEqual(v.fits, ["alice"]);
  assert.match(v.notes.join(" "), /XL in Vuori fitted 2 times/,
    "Alice's explanation survived Bob being processed after her");
});
