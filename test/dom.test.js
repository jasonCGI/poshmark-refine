// DOM-layer tests, under jsdom.
//
// These exist because the pure-logic suite was GREEN through every serious bug
// this extension has had: a grid that resolved to one tile, a resort/observer
// loop that froze the page, a badge that escaped its card, a stale verdict on a
// reused tile. All four were DOM-layer. The fixture is captured verbatim from a
// live results page, so it is also a selector-drift canary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  text, findGrids, wrapperOf, plan, resort, signatureOf, isOurs,
  shouldReapply, countStates, countTiles,
} from "../core/grid.js";

const SEL = {
  tile: "div.tile-grid-redesign",
  title: ".tile-grid-redesign__title",
  size: ".tile-grid-redesign__size",
  condition: ".tile-grid-redesign__condition-wrap",
  media: ".tile-grid-redesign__media--wrapper",
  link: "a.tile-grid-redesign__meta-link, a.tile__covershot",
};

const FIXTURE = readFileSync(new URL("../fixtures/poshmark-grid-2026-09-07.html", import.meta.url), "utf8");
const load = (html = FIXTURE) => new JSDOM(`<body>${html}</body>`).window.document;

// ------------------------------------------------- selector drift canary ----
test("the captured page still matches every selector the extension relies on", () => {
  const doc = load();
  const tiles = doc.querySelectorAll(SEL.tile);
  assert.equal(tiles.length, 4, "tile selector");
  assert.ok(doc.querySelector(".tiles_container"), "grid container");
  const card = tiles[0];
  for (const [name, sel] of Object.entries(SEL)) {
    if (name === "tile") continue;
    assert.ok(card.querySelector(sel), name + " selector (" + sel + ") no longer matches");
  }
  assert.equal(text(card, SEL.title), "Rails Sage Ruffle Top");
  assert.equal(text(card, SEL.size), "M");
});

// ---------------------------------------------------------- findGrids -------
test("the grid is NOT the tile's parent - each tile sits in its own column", () => {
  const doc = load();
  const tile = doc.querySelector(SEL.tile);
  // this is the bug that made the extension judge 1 of 48 results
  assert.equal(tile.parentElement.querySelectorAll(SEL.tile).length, 1);
  const grids = findGrids(doc, SEL);
  assert.equal(grids.length, 1);
  assert.ok(grids[0].classList.contains("tiles_container"));
  assert.equal(grids[0].querySelectorAll(SEL.tile).length, 4);
});

test("two results sections are both found, and their shared parent is not returned instead", () => {
  const doc = load(`<div id="outer">${FIXTURE}${FIXTURE}</div>`);
  const grids = findGrids(doc, SEL);
  assert.equal(grids.length, 2, "both sections");
  assert.ok(grids.every((g) => g.classList.contains("tiles_container")));
  assert.ok(!grids.some((g) => g.id === "outer"), "must not collapse to the common ancestor");
  assert.equal(countTiles(grids, SEL), 8);
});

test("a single-result page still yields a usable grid", () => {
  const doc = load();
  const cols = [...doc.querySelectorAll(".col-x12")];
  for (const c of cols.slice(1)) c.remove();
  const grids = findGrids(doc, SEL);
  assert.equal(grids.length, 1);
  assert.equal(countTiles(grids, SEL), 1);
});

test("wrapperOf returns the column, never the tile - detaching the tile breaks the layout", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  const tile = grid.querySelector(SEL.tile);
  const w = wrapperOf(tile, grid);
  assert.equal(w.parentElement, grid);
  assert.ok(w.classList.contains("col-x12"));
  assert.notEqual(w, tile);
});

// ------------------------------------------------------------- resort -------
test("resort orders show, then dim, then hide, moving wrappers", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  const tiles = [...grid.querySelectorAll(SEL.tile)];
  tiles[0].dataset.pmrOrder = "2";   // Rails -> hide
  tiles[1].dataset.pmrOrder = "0";   // Zara  -> show
  tiles[2].dataset.pmrOrder = "1";   // Blouse-> dim
  tiles[3].dataset.pmrOrder = "0";
  assert.equal(resort(grid, SEL), true);
  const order = [...grid.querySelectorAll(SEL.tile)].map((t) => t.dataset.pmrOrder);
  assert.deepEqual(order, ["0", "0", "1", "2"]);
  // every tile is still inside its own column, i.e. layout intact
  for (const t of grid.querySelectorAll(SEL.tile)) {
    assert.ok(t.parentElement.classList.contains("col-x12"));
  }
});

test("resort is IDEMPOTENT - a settled grid is not touched", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  // an order that genuinely needs moving: the first card sorts last
  const tiles = [...grid.querySelectorAll(SEL.tile)];
  tiles[0].dataset.pmrOrder = "2";
  tiles.slice(1).forEach((t) => { t.dataset.pmrOrder = "0"; });
  assert.equal(resort(grid, SEL), true, "first pass actually reorders");
  // second pass must report no change: re-appending an identical order still
  // moves nodes, which destroyed text selection and fed the observer loop
  assert.equal(plan(grid, SEL).changed, false);
  assert.equal(resort(grid, SEL), false);
});

// -------------------------------------------------- observer / the loop -----
test("our own writes NEVER warrant another pass - this is the freeze", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  for (const t of grid.querySelectorAll(SEL.tile)) {
    t.dataset.pmrSeen = "1";
    t.dataset.pmrSig = signatureOf(t, SEL);
  }
  const tile = grid.querySelector(SEL.tile);
  // a strip we appended, and text we wrote into it
  const strip = doc.createElement("div");
  strip.className = "pmr-strip";
  tile.appendChild(strip);
  strip.textContent = "size L, you asked for S/M";
  assert.equal(isOurs(strip), true);
  assert.equal(isOurs(strip.firstChild), true, "text node inside our strip");
  assert.equal(shouldReapply([{ target: strip, addedNodes: [strip.firstChild] }], SEL), false);

  // re-appending wrappers (what resort does) must not warrant a pass either
  const wraps = [...grid.children];
  const muts = wraps.map((w) => ({ target: grid, addedNodes: [w] }));
  assert.equal(shouldReapply(muts, SEL), false, "a re-ordered tile is not news");
});

test("a genuinely new tile from infinite scroll DOES warrant a pass", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  for (const t of grid.querySelectorAll(SEL.tile)) t.dataset.pmrSeen = "1";
  const col = grid.children[0].cloneNode(true);
  col.querySelector(SEL.tile).removeAttribute("data-pmr-seen");
  grid.appendChild(col);
  assert.equal(shouldReapply([{ target: grid, addedNodes: [col] }], SEL), true);
});

test("a card REUSED in place is detected by signature and re-opened for judging", () => {
  const doc = load();
  const grid = findGrids(doc, SEL)[0];
  const tile = grid.querySelector(SEL.tile);
  tile.dataset.pmrSeen = "1";
  tile.dataset.pmrSig = signatureOf(tile, SEL);

  // unchanged content -> not news
  assert.equal(shouldReapply([{ target: tile.querySelector(SEL.title), addedNodes: [] }], SEL), false);
  assert.equal(tile.dataset.pmrSeen, "1");

  // Poshmark swaps the title (virtualised grid) -> stale verdict must be re-judged
  tile.querySelector(SEL.title).textContent = " Vuori Performance Tee ";
  assert.equal(shouldReapply([{ target: tile.querySelector(SEL.title), addedNodes: [] }], SEL), true);
  assert.equal(tile.dataset.pmrSeen, undefined, "marker cleared so the next pass re-judges it");
});

test("signature covers the link too - same title, different listing", () => {
  const doc = load();
  const [a, b] = doc.querySelectorAll(SEL.tile);
  b.querySelector(SEL.title).textContent = a.querySelector(SEL.title).textContent;
  b.querySelector(SEL.size).textContent = text(a, SEL.size);
  assert.notEqual(signatureOf(a, SEL), signatureOf(b, SEL), "href must disambiguate");
});

// ------------------------------------------------------------- counts -------
test("counts tally across every grid, and the ad tile is countable but unstyled", () => {
  const doc = load(`${FIXTURE}${FIXTURE}`);
  const grids = findGrids(doc, SEL);
  const tiles = doc.querySelectorAll(SEL.tile);
  tiles[0].classList.add("pmr-show");
  tiles[1].classList.add("pmr-hide");
  tiles[2].classList.add("pmr-dim");
  // tiles[3] is the ad tile - deliberately left with no state
  const c = countStates(grids, SEL);
  assert.equal(c.show, 1); assert.equal(c.hide, 1); assert.equal(c.dim, 1);
  assert.equal(countTiles(grids, SEL), 8);
});

test("the ad tile has no title, so it is skipped but must still be markable", () => {
  const doc = load();
  const ad = [...doc.querySelectorAll(SEL.tile)].find((t) => !text(t, SEL.title));
  assert.ok(ad, "fixture carries an ad tile");
  // the convergence check keys off pmr-seen; an unmarkable tile would spin it
  ad.dataset.pmrSeen = "1";
  assert.equal(doc.querySelectorAll(SEL.tile + ":not([data-pmr-seen])").length, 3);
});
