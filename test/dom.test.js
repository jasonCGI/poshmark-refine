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
  shouldReapply, countStates, countTiles, allTiles, orphanTiles,
} from "../core/grid.js";
import {
  extractProduct, brandForHost, guessCategory, stripVariantSuffix, searchQueryFor,
} from "../core/brand.js";
import { poshmarkSearchUrl } from "../core/search.js";

const SEL = {
  tile: "div.tile-grid-redesign",
  title: ".tile-grid-redesign__title",
  size: ".tile-grid-redesign__size",
  condition: ".tile-grid-redesign__condition-wrap",
  media: ".tile-grid-redesign__media--wrapper",
  price: ".tile-grid-redesign__price-current",
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

// --------------------------------------- orphan tiles / the every-frame loop --
test("a lone card outside every detected grid is still a tile we must judge", () => {
  // A multi-card grid AND a single card sharing an outer ancestor. The lone
  // card's nearest multi-tile ancestor is #outer, which the innermost-container
  // filter correctly drops - so the card belongs to NO returned grid.
  const doc = load(
    '<div id="outer">' +
      '<div class="tiles_container">' +
        '<div class="col-x12"><div class="tile-grid-redesign"><span class="tile-grid-redesign__title">A</span></div></div>' +
        '<div class="col-x12"><div class="tile-grid-redesign"><span class="tile-grid-redesign__title">B</span></div></div>' +
      '</div>' +
      '<div class="solo"><div class="tile-grid-redesign"><span class="tile-grid-redesign__title">lone</span></div></div>' +
    '</div>');
  const grids = findGrids(doc, SEL);
  assert.equal(countTiles(grids, SEL), 2, "the lone card is not inside a detected grid");
  assert.equal(allTiles(doc, SEL).length, 3, "but it IS a tile on the page");

  const orphans = orphanTiles(doc, SEL);
  assert.equal(orphans.length, 1);
  assert.equal(text(orphans[0], SEL.title), "lone");

  // Judging from allTiles() marks every tile, so the document-wide convergence
  // check settles. Judging only grid members left this one permanently unseen,
  // which scheduled a pass every animation frame forever.
  for (const t of allTiles(doc, SEL)) t.dataset.pmrSeen = "1";
  assert.equal(doc.querySelectorAll(SEL.tile + ":not([data-pmr-seen])").length, 0,
    "convergence check must reach zero, or apply() loops every frame");
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

test("signature covers price and condition - a re-priced card must be re-judged", () => {
  const doc = load();
  const tile = doc.querySelector(SEL.tile);
  const price = tile.querySelector(SEL.price);
  const cond = tile.querySelector(SEL.condition);

  const before = signatureOf(tile, SEL);
  price.textContent = "$120";                       // the seller re-prices it
  assert.notEqual(signatureOf(tile, SEL), before, "a re-price must change the signature");

  // losing an NWT badge can flip a condition verdict, so it must count too
  cond.textContent = "NWT";
  const withNwt = signatureOf(tile, SEL);
  cond.textContent = "";
  assert.notEqual(signatureOf(tile, SEL), withNwt, "losing NWT must change the signature");
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

// ------------------------------------------- brand site -> Poshmark ---------
// Mirrors the real page at vuoriclothing.com/products/womens-elevation-square-
// neck-cami-velvet-violet-heather: JSON-LD Product carrying the variant name and
// the authoritative colourway, plus a CLEAN h1.
const VUORI = `
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product",
   "name":"Elevation Square Neck Cami - Velvet Violet Heather - XXS",
   "color":"Velvet Violet Heather","sku":"VW1532VVHXXS",
   "offers":[{"@type":"Offer","name":"Elevation Square Neck Cami - XS"},
             {"@type":"Offer","name":"Elevation Square Neck Cami - M"}]}
  </script>
  <h1>Elevation Square Neck Cami</h1>
  <button>XXS</button><button>XS</button><button>S</button><button>M</button>
  <button>L</button><button>XL</button><button>XXL</button><button>Add to cart</button>`;

test("a known brand host is recognised, an unknown one is not guessed", () => {
  assert.equal(brandForHost("vuoriclothing.com").brand, "Vuori");
  assert.equal(brandForHost("www.vuoriclothing.com").brand, "Vuori", "www. tolerated");
  assert.equal(brandForHost("example.com"), null);
  assert.equal(brandForHost(""), null);
});

test("the real Vuori page yields brand, clean name and the authoritative colourway", () => {
  const doc = load(VUORI);
  const p = extractProduct(doc, "vuoriclothing.com");
  assert.equal(p.brand, "Vuori");
  assert.equal(p.name, "Elevation Square Neck Cami", "h1 wins - JSON-LD name carries the variant");
  assert.equal(p.colour, "Velvet Violet Heather");
  assert.equal(p.category, "tops");
  assert.equal(p.sku, "VW1532VVHXXS");
  assert.equal(searchQueryFor(p), "Vuori Elevation Square Neck Cami");
});

test("with no h1, the JSON-LD name is stripped of its colour and size", () => {
  const doc = load(VUORI.replace(/<h1>.*<\/h1>/, ""));
  const p = extractProduct(doc, "vuoriclothing.com");
  assert.equal(p.name, "Elevation Square Neck Cami");
  assert.equal(p.colour, "Velvet Violet Heather");
});

test("stripVariantSuffix stops at the first segment that is neither colour nor size", () => {
  assert.equal(stripVariantSuffix("Cami - Bay Blue - XXS", "Bay Blue"), "Cami");
  assert.equal(stripVariantSuffix("Cami - M", null), "Cami");
  // a product whose own name contains " - " keeps it
  assert.equal(stripVariantSuffix("Sunday Track Pant - 30in - Bay Blue", "Bay Blue"), "Sunday Track Pant - 30in");
});

test("a page with no product is null, never a guess", () => {
  assert.equal(extractProduct(load("<h1>Womens Tops</h1>"), "example.com"), null, "unknown host");
  assert.equal(extractProduct(load("<div>no product here</div>"), "vuoriclothing.com"), null, "no name");
});

test("a product with no stated colourway is unknown, not colourless", () => {
  const doc = load('<script type="application/ld+json">{"@type":"Product","name":"Ponto Tee"}<\/script><h1>Ponto Tee</h1>');
  const p = extractProduct(doc, "vuoriclothing.com");
  assert.equal(p.colour, null, "null so the caller filters on no colourway at all");
  assert.equal(p.name, "Ponto Tee");
});

test("sizes come from offers when present, else from the page's own controls", () => {
  // this page's offers name XS and M, so they win and the DOM is not scanned
  const withOffers = extractProduct(load(VUORI), "vuoriclothing.com");
  assert.deepEqual(withOffers.sizes, ["XS", "M"]);

  // strip the offers and the button row is read instead - and only real sizes
  const noOffers = load(VUORI.replace(/,\s*"offers":\[[^\]]*\]/, ""));
  const p = extractProduct(noOffers, "vuoriclothing.com");
  assert.deepEqual(p.sizes, ["XXS", "XS", "S", "M", "L", "XL", "XXL"]);
  assert.ok(!p.sizes.includes("Add to cart"), "a button that is not a size is not a size");
});

test("category is guessed from the product name", () => {
  assert.equal(guessCategory("Elevation Square Neck Cami"), "tops");
  assert.equal(guessCategory("Sunday Performance Jogger"), "bottoms");
  assert.equal(guessCategory("Sunday Track Pant 30in"), "bottoms");
  assert.equal(guessCategory("Clementine Dress"), "dresses");
  assert.equal(guessCategory("Outdoor Trainer Shoe"), "shoes");
  assert.equal(guessCategory("Ripstop Jacket"), "outerwear");
  assert.equal(guessCategory("Sunday Pullover Hoodie"), "tops");
  assert.equal(guessCategory(""), "tops", "defaults rather than refusing");
});

test("the search URL is the shared one, and every facet sent is a verified one", () => {
  assert.equal(
    poshmarkSearchUrl({ query: "Vuori Elevation Square Neck Cami", department: "Women", category: "tops" }),
    "https://poshmark.com/search?query=Vuori+Elevation+Square+Neck+Cami&department=Women&category=Tops");
  // bottoms and outerwear now HAVE verified facet names, read off Poshmark's own
  // category links (they were omitted while that was still a guess)
  assert.match(poshmarkSearchUrl({ query: "x", category: "bottoms" }), /category=Pants_%26_Jumpsuits/);
  assert.match(poshmarkSearchUrl({ query: "x", category: "outerwear" }), /category=Jackets_%26_Coats/);
  // an unknown category still sends nothing rather than risk an empty page
  assert.ok(!poshmarkSearchUrl({ query: "x", category: "hats" }).includes("category="));
  assert.ok(!poshmarkSearchUrl({ query: "x", department: "All" }).includes("department="));
});
