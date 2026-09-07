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
  hasPendingLazy, promoteLazy, clampToViewport, selfCheck,
} from "../core/grid.js";
import {
  extractProduct, brandForHost, guessCategory, stripVariantSuffix, searchQueryFor,
  hostKey, sitesWith, brandFromJsonLd, BRAND_SITES, pruneBuiltIns,
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


// --- the lazy-load handoff our re-sort interrupts -------------------------
// Shape captured from a live search: <picture> with four <source data-srcset>
// and an <img data-src>, none of them promoted.
function lazyTile() {
  const d = new JSDOM(`<div class="tile-grid-redesign">
    <div class="tile-grid-redesign__media"><a class="tile__covershot"><div class="img__container"><picture>
      <source data-srcset="https://cdn/x.webp" type="image/webp">
      <source data-srcset="https://cdn/x.jpg" type="image/jpeg">
      <img data-src="https://cdn/x.jpg" alt="Vuori Grey Pullover" class="ovf--h d--b">
    </picture></div></a></div>
  </div>`);
  return d.window.document.querySelector(".tile-grid-redesign");
}

test("a cover the page prepared but never loaded is detected, and promoted once", () => {
  const tile = lazyTile();
  assert.equal(hasPendingLazy(tile), true);

  assert.equal(promoteLazy(tile), true);
  const img = tile.querySelector("img");
  assert.equal(img.getAttribute("src"), "https://cdn/x.jpg", "img src is promoted");
  for (const s of tile.querySelectorAll("source")) {
    assert.ok(s.getAttribute("srcset"), "every source is promoted, not just the img");
  }
  // nothing pending afterwards, so the observer can stop watching it
  assert.equal(hasPendingLazy(tile), false);
  assert.equal(promoteLazy(tile), false, "a second call is a no-op");
});

test("an already-loaded cover is left alone", () => {
  const tile = lazyTile();
  promoteLazy(tile);
  const before = tile.querySelector("img").getAttribute("src");
  // Poshmark would never re-point a loaded image; neither do we.
  tile.querySelector("img").setAttribute("data-src", "https://cdn/OTHER.jpg");
  promoteLazy(tile);
  assert.equal(tile.querySelector("img").getAttribute("src"), before,
    "src already set means hands off - we finish a load, we do not redirect one");
});

test("sources are promoted before the img, so <picture> can still choose", () => {
  const tile = lazyTile();
  const order = [];
  const doc = tile.ownerDocument;
  const mo = new doc.defaultView.MutationObserver((muts) => {
    for (const m of muts) order.push(m.target.tagName + ":" + m.attributeName);
  });
  mo.observe(tile, { attributes: true, subtree: true });
  promoteLazy(tile);
  return new Promise((res) => setTimeout(() => {
    mo.disconnect();
    const firstImg = order.findIndex((o) => o.startsWith("IMG"));
    const lastSource = order.map((o) => o.startsWith("SOURCE")).lastIndexOf(true);
    assert.ok(lastSource < firstImg,
      "img src set after every source srcset, else the fallback JPEG wins: " + order.join(","));
    res();
  }, 0));
});

// --- the HUD that walked off the bottom of the screen --------------------
test("a position saved on a taller window is pulled back into view", () => {
  // measured live: HUD 453x39 saved at top 864, window since shrunk to 839 tall
  const p = clampToViewport(16, 864, 453, 39, 1707, 839);
  assert.equal(p.left, 16, "left was already fine, leave it");
  assert.equal(p.top, 794, "839 - 39 - 6: back inside, not clipped to 0");
  assert.ok(p.top + 39 <= 839, "fully visible, so the drag handle is reachable again");
});

test("clamping holds at both edges and when the box is bigger than the window", () => {
  assert.deepEqual(clampToViewport(-500, -500, 100, 40, 1000, 800), { left: 6, top: 6 });
  assert.deepEqual(clampToViewport(9999, 9999, 100, 40, 1000, 800), { left: 894, top: 754 });
  // a window shorter than the HUD must not pin it ABOVE the top edge
  const tiny = clampToViewport(16, 100, 453, 39, 300, 20);
  assert.equal(tiny.top, 6);
  assert.equal(tiny.left, 6);
});

// --- the self-check: today's two bugs, made into assertions ---------------
// Geometry is injected, so a fixture CAN have a viewport for once.
const VIEW = { width: 1000, height: 800 };
const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });

function checkPage(html, { rects = new Map(), hud = null } = {}) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const rectOf = (el) => rects.get(el) || rects.get(el.className) || rect(0, 0, 200, 300);
  const found = selfCheck(doc, SEL, { rectOf, view: VIEW, hud: hud && doc.querySelector(hud) });
  return { doc, found, ids: found.map((f) => f.id) };
}

test("a healthy page reports nothing at all", () => {
  const { ids } = checkPage(`<div class="results">
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/x"><picture><img src="https://cdn/a.jpg"></picture></a></div>
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/y"><picture><img src="https://cdn/b.jpg"></picture></a></div>
  </div>`);
  assert.deepEqual(ids, [], "silence is the healthy state");
});

test("selectors matching nothing is reported, and short-circuits", () => {
  const { ids, found } = checkPage(`<div class="results"><article>Poshmark reskinned</article></div>`);
  assert.deepEqual(ids, ["selectors"]);
  assert.equal(found.length, 1, "zero problems across zero cards is not a clean bill of health");
});

test("BUG 0.15.0: a visible cover the re-sort never let load", () => {
  // exactly the shape measured live: data-src present, src absent
  const { ids, found } = checkPage(`<div class="results">
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/x"><picture>
      <source data-srcset="https://cdn/a.webp"><img data-src="https://cdn/a.jpg"></picture></a></div>
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/y"><picture><img src="https://cdn/b.jpg"></picture></a></div>
  </div>`);
  assert.ok(ids.includes("covers"));
  assert.match(found.find((f) => f.id === "covers").detail, /1 visible cover never loaded/);
});

test("a blank cover BELOW the fold is not a fault - it loads when scrolled to", () => {
  const dom = new JSDOM(`<div class="results">
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/x"><picture><img data-src="https://cdn/a.jpg"></picture></a></div>
  </div>`);
  const doc = dom.window.document;
  const offscreen = rect(0, 2000, 200, 300);   // far below an 800px viewport
  const found = selfCheck(doc, SEL, { rectOf: () => offscreen, view: VIEW });
  assert.deepEqual(found.map((f) => f.id), [], "not loading what nobody can see is correct behaviour");
});

test("BUG 0.15.0: the summary stranded outside the viewport", () => {
  const dom = new JSDOM(`<div class="results">
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/x"><picture><img src="https://cdn/a.jpg"></picture></a></div>
  </div><div id="pmr-hud">Refine</div>`);
  const doc = dom.window.document;
  const hud = doc.getElementById("pmr-hud");
  // the measured failure: 453x39 at top 864 in an 839px window
  const rectOf = (el) => (el === hud ? rect(16, 864, 453, 39) : rect(0, 0, 200, 300));
  const found = selfCheck(doc, SEL, { rectOf, view: { width: 1707, height: 839 }, hud });
  assert.ok(found.map((f) => f.id).includes("hud"));
  // and once clamped, it stops complaining
  const fixed = clampToViewport(16, 864, 453, 39, 1707, 839);
  const rectOf2 = (el) => (el === hud ? rect(fixed.left, fixed.top, 453, 39) : rect(0, 0, 200, 300));
  assert.ok(!selfCheck(doc, SEL, { rectOf: rectOf2, view: { width: 1707, height: 839 }, hud })
    .map((f) => f.id).includes("hud"), "the clamp fixes what the check reports");
});

test("an unjudged card, and a badge painting outside its own card", () => {
  const dom = new JSDOM(`<div class="results">
    <div class="tile-grid-redesign"><a class="tile__covershot" href="/x"><picture><img src="https://cdn/a.jpg"></picture></a></div>
    <div class="tile-grid-redesign" data-pmr-seen="1"><a class="tile__covershot" href="/y"><picture><img src="https://cdn/b.jpg"></picture></a>
      <span class="pmr-badge">Off</span></div>
  </div>`);
  const doc = dom.window.document;
  const badge = doc.querySelector(".pmr-badge");
  // badge escaping upward, which is how it landed on Poshmark's mega-menu
  const rectOf = (el) => (el === badge ? rect(10, -40, 40, 18) : rect(0, 0, 200, 300));
  const ids = selfCheck(doc, SEL, { rectOf, view: VIEW }).map((f) => f.id);
  assert.ok(ids.includes("unjudged"));
  assert.ok(ids.includes("badges"));
});

// --- brand sites the shopper adds ----------------------------------------
test("a pasted product URL, a bare host and a www host all name the same site", () => {
  assert.equal(hostKey("https://www.aloyoga.com/products/airbrush-legging"), "aloyoga.com");
  assert.equal(hostKey("aloyoga.com"), "aloyoga.com");
  assert.equal(hostKey("WWW.AloYoga.com/products/x"), "aloyoga.com");
  assert.equal(hostKey("  https://shop.example.co.uk/p/1  "), "shop.example.co.uk");
  assert.equal(hostKey(""), "", "nothing in, nothing out - never a guess");
  assert.equal(hostKey("not a url at all"), "not a url at all".split("/")[0]);
});

test("the shopper's sites join the built-in ones without displacing them", () => {
  const merged = sitesWith({ "https://www.aloyoga.com/products/x": {} });
  assert.ok(merged["vuoriclothing.com"], "built-ins survive");
  assert.ok(merged["aloyoga.com"], "and the pasted URL was reduced to a host");
  assert.equal(brandForHost("www.aloyoga.com", { "aloyoga.com": {} }) !== null, true);
  assert.equal(brandForHost("aloyoga.com"), null, "unknown without the extra list, still no guess");
});

test("a brand is read from the page when the site entry does not name one", () => {
  assert.equal(brandFromJsonLd({ brand: "Alo Yoga" }), "Alo Yoga");
  assert.equal(brandFromJsonLd({ brand: { "@type": "Brand", name: "Alo Yoga" } }), "Alo Yoga");
  assert.equal(brandFromJsonLd({ brand: { name: "  " } }), null);
  assert.equal(brandFromJsonLd({}), null);
  assert.equal(brandFromJsonLd(null), null);
});

test("an added site works end to end, and a nameless one is refused", () => {
  const page = (ld) => new JSDOM(`<h1>Airbrush High-Waist Legging</h1>
    <script type="application/ld+json">${JSON.stringify(ld)}</script>`).window.document;

  const ok = extractProduct(
    page({ "@type": "Product", name: "Airbrush Legging - Black", color: "Black", brand: { name: "Alo Yoga" } }),
    "www.aloyoga.com", { "aloyoga.com": {} });
  assert.equal(ok.brand, "Alo Yoga", "brand came from the page, not from us");
  assert.equal(ok.name, "Airbrush High-Waist Legging", "h1 still wins over the variant name");
  assert.equal(ok.colour, "Black");
  assert.equal(ok.category, "bottoms");

  // No brand anywhere: a Poshmark search for a bare product name would return
  // every brand's version of it, so we decline rather than mislead.
  const nameless = extractProduct(
    page({ "@type": "Product", name: "Airbrush Legging" }), "www.aloyoga.com", { "aloyoga.com": {} });
  assert.equal(nameless, null);

  // A built-in entry keeps its checked spelling even if the page disagrees.
  const builtin = extractProduct(
    page({ "@type": "Product", name: "Cami", brand: { name: "VUORI CLOTHING INC" } }), "vuoriclothing.com");
  assert.equal(builtin.brand, "Vuori");
});

test("a built-in site cannot also be added by hand", () => {
  // The manifest already ships a content script for it; registering a dynamic
  // one for the same pages injects the Find-on-Poshmark button twice.
  const optionsJs = readFileSync(new URL("../extension/options.js", import.meta.url), "utf8");
  assert.match(optionsJs, /BRAND_SITES\[host\]/, "adding a built-in host must be refused");
  // and the built-in list is what that guard is checking against
  assert.ok(Object.keys(BRAND_SITES).length > 0);
});

test("F5/F6: the service worker syncs on both permission transitions, and skips static hosts", () => {
  const sw = readFileSync(new URL("../extension/sw.js", import.meta.url), "utf8");
  assert.match(sw, /permissions\.onAdded/, "re-granting a revoked site left its bridge dead");
  assert.match(sw, /permissions\.onRemoved/);
  assert.match(sw, /STATIC_HOSTS/, "a host the manifest already covers must not get a second script");
});

test("F6: a stored entry cannot downgrade a built-in brand mapping", () => {
  // written before adding a built-in host was refused
  const legacy = { "vuoriclothing.com": {} };
  assert.deepEqual(sitesWith(legacy)["vuoriclothing.com"], { brand: "Vuori" },
    "the checked spelling wins over an empty legacy entry");
  assert.deepEqual(pruneBuiltIns(legacy), {}, "and the legacy entry is dropped on load");
  assert.deepEqual(pruneBuiltIns({ "aloyoga.com": {} }), { "aloyoga.com": {} }, "real additions survive");

  // the reported consequence: a product page with no JSON-LD brand
  const doc = new JSDOM(`<h1>Elevation Cami</h1>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Elevation Cami" })}</script>`).window.document;
  assert.equal(extractProduct(doc, "vuoriclothing.com", legacy).brand, "Vuori",
    "used to return null, because the legacy entry named no brand and the page named none either");
});

test("F7: the bridge button goes when the page stops resolving, not only on navigation", () => {
  const js = readFileSync(new URL("../extension/brand.js", import.meta.url), "utf8");
  // removing the site makes extraction fail at the SAME href; the old button
  // stayed clickable and still wrote search preferences for a revoked site
  assert.match(js, /if \(lastKey\) \{ document\.getElementById\(BTN_ID\)\?\.remove\(\)/,
    "removal must not be conditional on the URL having changed");
});
